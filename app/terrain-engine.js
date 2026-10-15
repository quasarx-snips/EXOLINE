// EXOLINE v0.2.1 — terrain engine.
//
// TERRAIN DOCTRINE
// Terrain elevation is a PURE DETERMINISTIC FUNCTION of (bodyId, lonDeg, latDeg).
// It returns bit-identical values across frames, sessions and reloads: there is
// no randomness at query time and nothing is persisted. Two layers compose it:
//
//   MACRO  — sampled once per body from that body's surface PNG luminance on a
//            512x256 offscreen grid, read back with bilinear interpolation.
//   DETAIL — 4 octaves of value noise keyed by a stable hash of (bodyId, ...),
//            with wavelengths given in METERS and converted to degrees through
//            the body's equatorial arc-per-degree, so the same feature keeps
//            the same physical size on every body.
//
// Gas bodies (solidSurface false) are rejected by init() with a clear error and
// are never sampled.
window.ExolineTerrain = (() => {
  'use strict';

  const GRID_W = 512, GRID_H = 256;
  const CACHE_CAP = 4;                 // LRU: bodies kept resident
  const WAVELENGTHS = [16000, 4000, 1000, 250]; // metres, coarse -> fine
  const AMPS = [0.35, 0.20, 0.10, 0.05];        // detail amplitude per octave

  // Per-body vertical scales in metres. macroScale scales the surface-PNG
  // luminance term, detailScale the summed octaves.
  const SCALES = {
    moon: [4000, 800],
    mercury: [5000, 1000],
    venus: [2000, 400],
    earth: [4000, 900],
    mars: [8000, 1200],
    titan: [1500, 300]
  };
  const DEFAULT_SCALE = [3000, 600];

  // ---- preloaded context (optional): lets app.js hand over data it already
  // fetched instead of paying for a second request.
  let catalog = null;       // data/solar_system.json
  let physics = null;       // data/physics_constants.json
  let assetVersion = null;  // data/terrain_manifest.json .version
  let contextFetch = null;  // in-flight lazy fetch of whatever is missing

  const bodies = new Map(); // bodyId -> record, in LRU order (oldest first)
  const pending = new Map();

  function setContext(next) {
    if (!next) return;
    if (next.catalog) catalog = next.catalog;
    if (next.physics) physics = next.physics;
    if (next.assetVersion) assetVersion = next.assetVersion;
  }

  function ensureContext() {
    const needCatalog = !catalog, needPhysics = !physics, needVersion = !assetVersion;
    if (!needCatalog && !needPhysics && !needVersion) return Promise.resolve();
    if (!contextFetch) {
      contextFetch = Promise.all([
        needCatalog ? fetch('../data/solar_system.json').then(r => r.json()) : null,
        needPhysics ? fetch('../data/physics_constants.json').then(r => r.json()) : null,
        needVersion ? fetch('../data/terrain_manifest.json').then(r => r.json()) : null
      ]).then(([c, p, t]) => {
        if (c) catalog = c;
        if (p) physics = p;
        if (t && t.version) assetVersion = t.version;
      });
    }
    return contextFetch;
  }

  // ---- deterministic integer hash: xorshift-multiply (xorshift32 with a
  // multiplicative finalizer). Same inputs always produce the same [0,1).
  function hash(x, y, octave, seed) {
    let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(octave | 0, 1442695040) ^ (seed | 0);
    h = Math.imul(h ^ (h >>> 15), 2246822519);
    h = Math.imul(h ^ (h >>> 13), 3266489917);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }

  // FNV-1a over the bodyId: a stable 32-bit seed per body.
  function seedOf(bodyId) {
    let h = 2166136261;
    for (let i = 0; i < bodyId.length; i++) {
      h ^= bodyId.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h | 0;
  }

  // Body ids in this project are namespaced by parent for moons
  // ("earth:moon", "saturn:titan"), while the table above is keyed by the bare
  // body name, so a moon would otherwise silently fall through to
  // DEFAULT_SCALE. Try the id as-is, then the segment after the last colon.
  function scalesFor(bodyId) {
    if (SCALES[bodyId]) return SCALES[bodyId];
    const colon = bodyId.lastIndexOf(':');
    if (colon >= 0) {
      const bare = bodyId.slice(colon + 1);
      if (SCALES[bare]) return SCALES[bare];
    }
    return DEFAULT_SCALE;
  }

  function imageSrc(path) {
    // Same cache key the map renderer uses, so the profile can never be drawn
    // from a different revision of the PNG than the map underneath it.
    return '../' + path + (assetVersion ? '?v=' + encodeURIComponent(assetVersion) : '');
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('terrain: could not load surface asset ' + src));
      image.src = src;
    });
  }

  function sampleGrid(image) {
    const canvas = document.createElement('canvas');
    canvas.width = GRID_W; canvas.height = GRID_H;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(image, 0, 0, GRID_W, GRID_H);
    const data = ctx.getImageData(0, 0, GRID_W, GRID_H).data;
    const grid = new Float32Array(GRID_W * GRID_H);
    for (let i = 0, p = 0; i < grid.length; i++, p += 4) {
      // Rec. 709 relative luminance, normalised to [0,1].
      grid[i] = (0.2126 * data[p] + 0.7152 * data[p + 1] + 0.0722 * data[p + 2]) / 255;
    }
    return grid;
  }

  function touch(bodyId) {
    const rec = bodies.get(bodyId);
    if (!rec) return;
    bodies.delete(bodyId);
    bodies.set(bodyId, rec);
  }

  function trim() {
    while (bodies.size > CACHE_CAP) bodies.delete(bodies.keys().next().value);
  }


  function init(bodyId) {
    if (bodies.has(bodyId)) { touch(bodyId); return Promise.resolve(); }
    if (pending.has(bodyId)) return pending.get(bodyId);
    const task = (async () => {
      await ensureContext();
      const entry = catalog && Array.isArray(catalog.bodies) ? catalog.bodies.find(b => b.id === bodyId) : null;
      if (!entry) throw new Error('terrain: unknown body "' + bodyId + '"');
      const phys = physics && physics.bodies ? physics.bodies[bodyId] : null;
      if (!phys) throw new Error('terrain: no physical record for "' + bodyId + '"');
      if (!phys.solidSurface) throw new Error('terrain: "' + bodyId + '" is a gas body with no solid surface — terrain sampling rejected');
      if (!entry.surface_asset) throw new Error('terrain: no surface asset declared for "' + bodyId + '"');
      const image = await loadImage(imageSrc(entry.surface_asset));
      const scale = scalesFor(bodyId);
      const rec = {
        id: bodyId,
        grid: sampleGrid(image),
        radiusM: phys.radius_m,
        arcMPerDegLon: Math.PI * phys.radius_m / 180,
        macroScale: scale[0],
        detailScale: scale[1],
        seed: seedOf(bodyId)
      };
      bodies.set(bodyId, rec);
      trim();
      pending.delete(bodyId);
    })();
    pending.set(bodyId, task);
    task.catch(() => pending.delete(bodyId));
    return task;
  }

  function record(bodyId) {
    const rec = bodies.get(bodyId);
    if (!rec) throw new Error('terrain: not ready for "' + bodyId + '" (call init first)');
    touch(bodyId);
    return rec;
  }

  function macroMeters(rec, lonDeg, latDeg) {
    const grid = rec.grid;
    let u = ((lonDeg + 180) / 360) * GRID_W;
    u = ((u % GRID_W) + GRID_W) % GRID_W;                 // longitude wraps
    const vRaw = ((90 - latDeg) / 180) * GRID_H;
    const v = Math.max(0, Math.min(GRID_H - 1e-9, vRaw)); // latitude clamps
    const x0 = Math.floor(u) % GRID_W, x1 = (x0 + 1) % GRID_W;
    const y0 = Math.floor(v), y1 = Math.min(GRID_H - 1, y0 + 1);
    const fx = u - Math.floor(u), fy = v - y0;
    const l00 = grid[y0 * GRID_W + x0], l10 = grid[y0 * GRID_W + x1];
    const l01 = grid[y1 * GRID_W + x0], l11 = grid[y1 * GRID_W + x1];
    const lum = (l00 * (1 - fx) + l10 * fx) * (1 - fy) + (l01 * (1 - fx) + l11 * fx) * fy;
    return (lum - 0.5) * 2 * rec.macroScale;
  }

  function detailMeters(rec, lonDeg, latDeg) {
    const eastM = lonDeg * rec.arcMPerDegLon;
    const northM = latDeg * rec.arcMPerDegLon;
    let sum = 0;
    for (let i = 0; i < WAVELENGTHS.length; i++) {
      const wavelength = WAVELENGTHS[i];
      const fx = eastM / wavelength, fy = northM / wavelength;
      const xi = Math.floor(fx), yi = Math.floor(fy);
      const tx = fx - xi, ty = fy - yi;
      const h00 = hash(xi, yi, i, rec.seed), h10 = hash(xi + 1, yi, i, rec.seed);
      const h01 = hash(xi, yi + 1, i, rec.seed), h11 = hash(xi + 1, yi + 1, i, rec.seed);
      const value = (h00 * (1 - tx) + h10 * tx) * (1 - ty) + (h01 * (1 - tx) + h11 * tx) * ty;
      sum += AMPS[i] * rec.detailScale * (value * 2 - 1);
    }
    return sum;
  }

  function elevationOf(rec, lonDeg, latDeg) {
    return macroMeters(rec, lonDeg, latDeg) + detailMeters(rec, lonDeg, latDeg);
  }

  function elevation(bodyId, lonDeg, latDeg) {
    return elevationOf(record(bodyId), lonDeg, latDeg);
  }

  function slopeDeg(bodyId, lonDeg, latDeg) {
    const rec = record(bodyId);
    const step = 50 / rec.arcMPerDegLon;   // 50 m expressed in degrees
    const run = 100;                       // central difference spans +/-50 m
    const dEast = (elevationOf(rec, lonDeg + step, latDeg) - elevationOf(rec, lonDeg - step, latDeg)) / run;
    const dNorth = (elevationOf(rec, lonDeg, latDeg + step) - elevationOf(rec, lonDeg, latDeg - step)) / run;
    return Math.atan(Math.hypot(dEast, dNorth)) * 180 / Math.PI;
  }

  function roughness(bodyId, lonDeg, latDeg) {
    const rec = record(bodyId);
    const step = 25 / rec.arcMPerDegLon;   // 25 m expressed in degrees
    let lo = Infinity, hi = -Infinity;
    for (let j = -1; j <= 1; j++) {
      for (let i = -1; i <= 1; i++) {
        const e = elevationOf(rec, lonDeg + i * step, latDeg + j * step);
        if (e < lo) lo = e;
        if (e > hi) hi = e;
      }
    }
    return hi - lo;
  }

  function siteScore(bodyId, lonDeg, latDeg) {
    const slopePart = Math.max(0, Math.min(60, slopeDeg(bodyId, lonDeg, latDeg) * 6));
    const roughPart = Math.max(0, Math.min(25, roughness(bodyId, lonDeg, latDeg) / 50 * 25));
    return Math.round(Math.max(0, Math.min(100, 100 - slopePart - roughPart)));
  }

  function profilePoints(bodyId, lonC, latC, spanM, count) {
    const rec = record(bodyId);
    const n = Math.max(2, Math.floor(count) || 2);
    const span = Number.isFinite(spanM) && spanM > 0 ? spanM : 1;
    const points = new Array(n);
    for (let i = 0; i < n; i++) {
      const dE = -span / 2 + span * i / (n - 1);
      points[i] = { dE, elev: elevationOf(rec, lonC + dE / rec.arcMPerDegLon, latC) };
    }
    return points;
  }

  function isReady(bodyId) { return bodies.has(bodyId); }

  return {
    init,
    elevation,
    slopeDeg,
    roughness,
    siteScore,
    profilePoints,
    isReady,
    setContext,
    EVICTION_CAP: CACHE_CAP,
    WAVELENGTHS,
    AMPS,
    VERSION: '0.2.1'
  };
})();
