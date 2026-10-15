(() => {
  const $ = id => document.getElementById(id), C = $('scene'), X = C.getContext('2d');
  const AU = 149597870700, WARP = [1, 10, 100, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9], images = new Map(), keys = {};
  let D, P, A, minerals = null, F, S = {}, sel, craftSelected = false, lock = null, date = new Date('2026-10-05T12:00:00Z');
  let running = true, warpIndex = 0, lastFrame = performance.now(), simulationBacklog = 0, drag, terrain, mapRenderer, rcs = false, frameCount = 0;
  let panning = false, panDrag = { x: 0, y: 0 }, panned = false;
  keys.pan = { up: false, down: false, left: false, right: false };
  let navSnap = null, activeNodeId = null, toastTimer = 0, autoBurn = null, nodeHitRegions = [], orbitHitRegions = [];
  // ===== v0.2.0 SURFACE FRAMEWORK =====
  // EQUATORIAL BAND DOCTRINE (design law): EXOLINE orbits in a single 2D
  // plane. That plane maps to each body's EQUATOR on its equirectangular
  // surface map. Every landing therefore has latitude exactly 0.0; surface
  // longitude comes from the in-plane landing angle theta. No rotation, no
  // spin, no axial tilt, no 3D projection is invented here — all surface
  // activity happens in the equatorial band. This is intentional.
  const SURFACE_TEMP_C = { mercury: 167, venus: 464, earth: 15, mars: -63, moon: -20, titan: -179 };
  const SURF_SITES_KEY = 'exoline.sites.v1';
  let viewMode = 'orbit'; // 'orbit' | 'surface'
  let surfSites = [];
  try { const raw = localStorage.getItem(SURF_SITES_KEY); if (raw) { const arr = JSON.parse(raw); if (Array.isArray(arr)) surfSites = arr; } } catch { surfSites = []; }
  let surfPrevLanded = false, surfPrevCrashed = false, surfPinWarned = false;
  const surfWrap180 = x => ((x + 180) % 360 + 360) % 360 - 180;
  window.ExolineSurfaceState = null;
  function surfBodyName(id) { try { return ExolineNav.bodyName(id); } catch { const b = D && D.bodies.find(q => q.id === id); return (b && b.name) || id; } }
  function getSites() { return surfSites; }
  window.ExolineSites = { getSites };
  // ===== end v0.2.0 surface state =====
  const nodeAnchors = new Map();
  const defaultBindings = { pause: 'Space', warpDown: 'BracketLeft', warpUp: 'BracketRight', focusCraft: 'KeyF', resetView: 'KeyR', addNode: 'KeyN', autoBurn: 'KeyB', stage: 'KeyX', chute: 'KeyP', descent: 'KeyV' };
  // v0.2.0 §1: edge-triggered coordinate capture on landed/crashed edges.
  // silent=true adopts coordinates without minting a registry entry (used
  // once at startup so a parked pad start doesn't pollute the registry on
  // every page reload).
  function surfCapture(kind, silent = false) {
    if (!F || !S) return;
    const id = (kind === 'wreck') ? null : (F.landedBody || null);
    const refId = id || (typeof F.referenceBody === 'function' ? F.referenceBody(S, F.s) : (typeof F.dominant === 'function' ? F.dominant(S) : null));
    const body = refId && S[refId], physical = refId && P.bodies[refId];
    if (!body || !physical) return;
    const rx = F.s.r.x - body.x, ry = F.s.r.y - body.y;
    const theta = Math.atan2(ry, rx);
    const lonDeg = surfWrap180(theta * 180 / Math.PI);
    const arcMPerDegLon = Math.PI * physical.radius_m / 180;
    window.ExolineSurfaceState = { bodyId: refId, lonDeg, latDeg: 0.0, arcMPerDegLon, kind };
    surfPinWarned = false;
    if (mapRenderer && mapRenderer.surf) mapRenderer.surf.siteLon = lonDeg;
    if (!silent) surfRegisterSite(refId, lonDeg, kind);
    syncSurfaceBtn();
  }
  // v0.2.0 §2: sites registry in localStorage, cap 50, persist on push.
  function surfRegisterSite(bodyId, lonDeg, kind) {
    const n = (surfRegisterSite._next = (surfRegisterSite._next || (surfSites.reduce((m, s) => Math.max(m, s.id || 0), 0) + 1)));
    surfRegisterSite._next = n + 1;
    surfSites.push({ id: n, bodyId, lonDeg: +lonDeg.toFixed(4), latDeg: 0, kind, t: new Date().toISOString(), name: 'SITE-' + String(n).padStart(3, '0') + ' ' + surfBodyName(bodyId) });
    while (surfSites.length > 50) surfSites.shift();
    try { localStorage.setItem(SURF_SITES_KEY, JSON.stringify(surfSites)); } catch { /* sites stay in memory */ }
  }
  // v0.2.0 §1: per-frame edge detection + pin-integrity watchdog.
  let surfPrimed = false;
  function surfTrackTransitions() {
    if (!F) return;
    const landed = !!F.s.landed, crashed = !!F.s.crashed;
    if (!surfPrimed) {
      // First frame: adopt current parked/pad coordinates silently so the
      // surface button works from a pad start, without writing a registry
      // entry. A real touchdown later still fires the edge.
      surfPrimed = true;
      surfPrevLanded = landed; surfPrevCrashed = crashed;
      if (landed && !window.ExolineSurfaceState) surfCapture('landing', true);
      if (crashed && !window.ExolineSurfaceState) {
        try {
          const refId = (typeof F.referenceBody === 'function') ? F.referenceBody(S, F.s) : null;
          if (refId && P.bodies[refId] && P.bodies[refId].solidSurface) surfCapture('wreck', true);
        } catch { /* no solid reference */ }
      }
      syncSurfaceBtn();
      return;
    }
    if (landed && !surfPrevLanded) surfCapture('landing');
    if (crashed && !surfPrevCrashed) {
      try {
        const refId = (typeof F.referenceBody === 'function') ? F.referenceBody(S, F.s) : null;
        if (refId && P.bodies[refId] && P.bodies[refId].solidSurface) surfCapture('wreck');
      } catch { /* no solid reference: no wreck site */ }
    }
    if (!landed && !crashed && viewMode === 'surface') exitSurface(false);
    if (landed && window.ExolineSurfaceState && !surfPinWarned) {
      const st = window.ExolineSurfaceState, body = S[st.bodyId];
      if (body) {
        const th = Math.atan2(F.s.r.y - body.y, F.s.r.x - body.x) * 180 / Math.PI;
        if (Math.abs(surfWrap180(th - st.lonDeg)) > 0.01) { surfPinWarned = true; console.warn('[surface] pin drift: live lon differs from stored lon'); }
      }
    }
    surfPrevLanded = landed; surfPrevCrashed = crashed;
    syncSurfaceBtn();
  }
  // v0.2.0 §4: view state machine. enterSurface never writes cam, so the
  // orbit camera survives untouched and exitSurface restores it exactly.
  function surfAllowed() {
    if (!F) return false;
    if (!(F.s.landed || F.s.crashed)) return false;
    const st = window.ExolineSurfaceState;
    if (st) { const p = P.bodies[st.bodyId]; return !!(p && p.solidSurface); }
    try {
      const refId = (typeof F.referenceBody === 'function') ? F.referenceBody(S, F.s) : null;
      const p = refId && P.bodies[refId];
      return !!(p && p.solidSurface);
    } catch { return false; }
  }
  function syncSurfaceBtn() {
    const btn = $('surfaceBtn');
    if (!btn) return;
    const ok = surfAllowed();
    btn.disabled = !ok;
    btn.title = ok ? 'Surface view (Enter)' : 'No solid surface';
    btn.classList.toggle('is-on', viewMode === 'surface');
    btn.setAttribute('aria-pressed', String(viewMode === 'surface'));
  }
  async function enterSurface() {
    const st = window.ExolineSurfaceState;
    if (!st || !surfAllowed()) { showToast('NO SOLID SURFACE'); return; }
    const physical = P.bodies[st.bodyId];
    const entry = D && D.bodies.find(b => b.id === st.bodyId);
    terrain = terrain || await (await fetch('../data/terrain_manifest.json')).json();
    const manifest = (terrain && terrain.bodies && terrain.bodies[st.bodyId]) || null;
    if (!mapRenderer) mapRenderer = new ExolineMap.MapRenderer($('mapCanvas'), { terrainManifest: manifest, onZoom: mpp => { setText('surfZoom', `${Number(mpp).toFixed(1)} m/px`); } });
    C.style.display = 'none';
    $('mapCanvas').classList.remove('hidden'); $('mapCanvas').style.display = 'block';
    $('mapTopbar').classList.add('hidden');
    // v0.2.0 FIX: a hidden canvas reports 0x0, so a renderer built while
    // #mapCanvas is display:none locks in a 1x1 backing store and the
    // calibrated zoom explodes (~227000x on the Moon -> solid color).
    // Re-measure AFTER unhiding, before openSurface calibrates.
    try { mapRenderer.resize(); } catch { /* keep constructor size */ }
    if (entry && mapRenderer.body !== entry) { try { await mapRenderer.open(entry, manifest); } catch { /* tiles optional */ } }
    viewMode = 'surface';
    mapRenderer.openSurface(manifest, st.bodyId, st.lonDeg, 50, physical ? physical.radius_m : 1);
    mapRenderer.registerMarkerLayer(drawSurfaceMarkers);
    $('app').classList.add('surface-fade', 'surface-mode');
    clearTimeout(enterSurface._t);
    enterSurface._t = setTimeout(() => $('app').classList.remove('surface-fade'), 450);
    $('surfaceHud').classList.remove('hidden');
    syncSurfaceBtn();
    showToast('SURFACE VIEW · ' + surfBodyName(st.bodyId).toUpperCase());
  }
  function exitSurface(fade = true) {
    if (viewMode !== 'surface') return;
    viewMode = 'orbit';
    $('app').classList.remove('surface-mode');
    if (mapRenderer) { try { mapRenderer.registerMarkerLayer(null); mapRenderer.closeSurface(); } catch { /* never break exit */ } }
    $('mapCanvas').classList.add('hidden'); $('mapCanvas').style.display = 'none';
    C.style.display = 'block';
    $('surfaceHud').classList.add('hidden');
    if (fade) {
      $('app').classList.add('surface-fade');
      clearTimeout(exitSurface._t);
      exitSurface._t = setTimeout(() => $('app').classList.remove('surface-fade'), 450);
    } else $('app').classList.remove('surface-fade');
    syncSurfaceBtn();
  }
  function toggleSurface() { if (viewMode === 'surface') exitSurface(true); else enterSurface(); }
  // ===== end v0.2.0 view machine =====
  // v0.2.0 §6: surface markers via registerMarkerLayer; orbit site ticks.
  function surfActiveSite() {
    const st = window.ExolineSurfaceState;
    if (!st) return null;
    let best = null;
    for (const s of surfSites) {
      if (s.bodyId !== st.bodyId) continue;
      if (Math.abs(surfWrap180(s.lonDeg - st.lonDeg)) < 0.05) { best = s; break; }
      if (!best) best = s;
    }
    return best;
  }
  function drawSurfaceMarkers(ctx, tr) {
    const st = window.ExolineSurfaceState;
    if (!st || !tr || !mapRenderer || !mapRenderer.surf) return;
    const R = mapRenderer.surfaceMetersToScreen.bind(mapRenderer);
    const arc = st.arcMPerDegLon;
    const cLon = mapRenderer.surf.centerLon, cLat = mapRenderer.surf.centerLat || 0;
    for (const s of surfSites) {
      if (s.bodyId !== st.bodyId) continue;
      // Offsets from the CURRENT pan center (the transform origin), not from
      // the stored craft lon, so markers track correctly while panning.
      const dE = surfWrap180(s.lonDeg - cLon) * arc, dN = ((s.latDeg || 0) - cLat) * arc;
      const p = R(dE, dN);
      if (!p || p.x < -20 || p.y < -20 || p.x > mapRenderer.width + 20 || p.y > mapRenderer.height + 20) continue;
      ctx.save();
      ctx.strokeStyle = s.kind === 'wreck' ? '#ff5555' : '#66ff99';
      ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.arc(p.x, p.y, 5, 0, Math.PI * 2); ctx.stroke();
      if (tr.mPerPx < 500 && s.name) { ctx.fillStyle = '#eaf7ff'; ctx.font = '9px sans-serif'; ctx.fillText(s.name, p.x + 8, p.y - 6); }
      ctx.restore();
    }
    const cp = R(surfWrap180(st.lonDeg - cLon) * arc, (st.latDeg - cLat) * arc);
    if (cp && cp.x > -30 && cp.y > -30 && cp.x < mapRenderer.width + 30 && cp.y < mapRenderer.height + 30) {
      ctx.save();
      ctx.fillStyle = '#f8fdff'; ctx.strokeStyle = '#0b3040'; ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.moveTo(cp.x, cp.y - 7); ctx.lineTo(cp.x + 6, cp.y + 6); ctx.lineTo(cp.x - 6, cp.y + 6); ctx.closePath();
      ctx.fill(); ctx.stroke();
      ctx.restore();
    }
  }
  function drawSiteTicks() {
    if (!surfSites.length || viewMode !== 'orbit' || !P) return;
    for (const s of surfSites) {
      const body = S[s.bodyId], physical = P.bodies[s.bodyId];
      if (!body || !physical) continue;
      const screenR = physical.radius_m * cam.k;
      if (screenR < 4) continue;
      const th = s.lonDeg * Math.PI / 180;
      const p = ws({ x: body.x + Math.cos(th) * physical.radius_m, y: body.y + Math.sin(th) * physical.radius_m });
      const c = ws(body);
      const dx = p.x - c.x, dy = p.y - c.y, m = Math.hypot(dx, dy) || 1;
      X.save();
      X.strokeStyle = s.kind === 'wreck' ? '#ff5555' : '#66ff99';
      X.lineWidth = 1.6;
      X.beginPath();
      X.moveTo(c.x + dx / m * (m - 4), c.y + dy / m * (m - 4));
      X.lineTo(c.x + dx / m * (m + 4), c.y + dy / m * (m + 4));
      X.stroke();
      X.restore();
    }
  }
  // v0.2.0 §5: surface HUD at the existing throttled hud() rate.
  function surfaceHud() {
    const st = window.ExolineSurfaceState;
    setText('surfLat', '0.00°');
    if (!st) return;
    const physical = P.bodies[st.bodyId];
    setText('surfBody', surfBodyName(st.bodyId).toUpperCase());
    setText('surfLon', `${st.lonDeg.toFixed(2)}°`);
    const site = surfActiveSite();
    if (site) {
      const dE = surfWrap180(st.lonDeg - site.lonDeg) * st.arcMPerDegLon;
      const dN = (st.latDeg - (site.latDeg || 0)) * st.arcMPerDegLon;
      setText('surfOffE', `${Math.round(dE).toLocaleString('en-US')} m`);
      setText('surfOffN', `${Math.round(dN).toLocaleString('en-US')} m`);
    } else { setText('surfOffE', '0 m'); setText('surfOffN', '0 m'); }
    if (physical) {
      const g = P.G * physical.mass / (physical.radius_m * physical.radius_m);
      setText('surfG', `${g.toFixed(2)} m/s²`);
      let p0 = 0;
      try {
        const atm = ExolineFlight.atmospheres && (ExolineFlight.atmospheres[st.bodyId] || ExolineFlight.atmospheres[(st.bodyId.split(':')[1] || st.bodyId)]);
        if (atm && physical.solidSurface) p0 = atm.surfaceDensity || 0;
      } catch { p0 = 0; }
      setText('surfP', `${Number(p0).toLocaleString('en-US')} Pa`);
    }
    const short = st.bodyId.split(':').pop();
    const tc = (SURFACE_TEMP_C[st.bodyId] !== undefined) ? SURFACE_TEMP_C[st.bodyId] : (SURFACE_TEMP_C[short] !== undefined ? SURFACE_TEMP_C[short] : -150);
    setText('surfT', `${tc} °C`);
    setText('surfStatus', F && F.s.crashed ? 'WRECKED' : 'LANDED');
    const tr = (viewMode === 'surface' && mapRenderer) ? mapRenderer.getSurfaceTransform() : null;
    if (tr) setText('surfZoom', `${Number(tr.mPerPx).toFixed(1)} m/px`);
  }
  // ===== end v0.2.0 markers/HUD =====
  let bindings = { ...defaultBindings };
  try { bindings = { ...defaultBindings, ...JSON.parse(localStorage.getItem('exoline.keybinds') || '{}') }; } catch { /* use defaults */ }
  const bindingLabel = code => code === 'Space' ? 'Space' : code.replace(/^Key/, '').replace(/^Digit/, '');
  const matches = (event, action) => event.code === bindings[action];
  const cam = { o: { x: 0, y: 0 }, k: innerHeight / (2.5 * AU) };
  const icon = (name, path) => `<svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="${path}"/></svg>`;
  const rewindIcon = icon('rewind', 'm11 19-9-7 9-7v14Zm11 0-9-7 9-7v14Z');
  const forwardIcon = icon('forward', 'm13 5 9 7-9 7V5ZM2 5l9 7-9 7V5Z');
  const pauseIcon = icon('pause', 'M8 5v14M16 5v14');
  const playIcon = icon('play', 'm8 5 11 7-11 7V5Z');
  const img = src => { if (!images.has(src)) { const image = new Image(); image.src = '../' + src; images.set(src, image); } return images.get(src); };
  const ws = p => ({ x: innerWidth / 2 + (p.x - cam.o.x) * cam.k, y: innerHeight / 2 - (p.y - cam.o.y) * cam.k });
  const sw = (x, y) => ({ x: cam.o.x + (x - innerWidth / 2) / cam.k, y: cam.o.y - (y - innerHeight / 2) / cam.k });
  const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: (a.z || 0) - (b.z || 0) });
  const len = a => Math.hypot(a.x, a.y, a.z || 0);
  const finite = n => Number.isFinite(n);
  // Curve tessellation: enough segments that no chord exceeds ~6 px on screen,
  // so ellipses never read as polylines at any zoom. Bounded for perf.
  const smoothCount = (worldLen, min, max) => Math.max(min, Math.min(max, Math.ceil(worldLen * cam.k / 6)));
  const ellipsePerimeter = (a, b) => Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b)));

  // Local frame of the body the craft is currently sitting inside (if any).
  // Outside an SOI the transform is the identity, so draw routines keep
  // behaving in the solar-system frame; inside one, conics/escape paths are
  // drawn around the body that owns the SOI the craft has just entered.
  let currentSoi = null; // { id, dist, soi } | null
  const t = p => currentSoi ? { x: p.x - S[currentSoi.id].x, y: p.y - S[currentSoi.id].y } : p;

  // Body whose sphere of influence the craft is currently inside, or null.
  function soiBody() {
    if (!craftSelected || !F) return null;
    // SOI is a navigation classification, not the body exerting the largest
    // instantaneous pull. Gravity dominance can switch well inside a nominal
    // SOI, which previously made local navigation flicker during escape.
    let selected = null;
    for (const body of D?.bodies || []) {
      if (!S[body.id]) continue;
      const soi = ExolineNav.soiRadius(body.id);
      if (!finite(soi) || soi <= 0) continue;
      const dist = len(sub(F.s.r, S[body.id]));
      if (dist > soi) continue;
      if (!selected || soi < selected.soi) selected = { id: body.id, dist, soi };
    }
    return selected;
  }
  const number = n => !finite(n) ? '—' : n > 1e9 ? `${(n / 1e9).toFixed(2)}G` : n > 1e6 ? `${(n / 1e6).toFixed(2)}M` : n > 1e3 ? `${(n / 1e3).toFixed(1)}k` : n.toFixed(1);
  const altitude = n => `${number(Math.max(0, n) / 1000)} km`;
  const warpText = n => n >= 1e9 ? `${n / 1e9}B×` : n >= 1e6 ? `${n / 1e6}M×` : n >= 1e3 ? `${n / 1e3}k×` : `${n}×`;
  const setText = (id, value) => { const el = $(id); if (el && el.textContent !== value) el.textContent = value; };
  function showToast(message) { const el = $('toast'); if (!el) return; el.textContent = message; el.style.opacity = '1'; clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.style.opacity = '0'; }, 2300); }
  const setThrottle = (value, automated = false) => { if (autoBurn && !automated) return; if (F && F.descentMode && !automated) return; const level = Math.max(0, Math.min(100, Math.round(+value))); if (F) F.s.throttle = level / 100; $('throttle').value = String(level); $('throttleReadout').textContent = `${level}%`; $('throttleDial').style.setProperty('--lvl', level); };
  const rotationHours = { sun: 609.12, mercury: 1407.6, venus: -5832.5, earth: 23.934, mars: 24.623, jupiter: 9.925, saturn: 10.656, uranus: -17.24, neptune: 16.11, pluto: -153.3, ceres: 9.07, haumea: 3.915, makemake: 22.5, eris: 25.9 };
  const rotationAngle = body => ((+date - Date.parse('2000-01-01T12:00:00Z')) / 3600000 / (rotationHours[body.id] || 24)) * Math.PI * 2;

  function resize() { const d = Math.min(3, devicePixelRatio || 1); C.width = innerWidth * d; C.height = innerHeight * d; X.setTransform(d, 0, 0, d, 0, 0); X.imageSmoothingEnabled = true; X.imageSmoothingQuality = 'high'; }
  async function updateStates() {
    const nextDate = new Date(+date + 1000), [positions, nextPositions] = await Promise.all([ExolineOrbit.positions(date), ExolineOrbit.positions(nextDate)]);
    S = { sun: { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 } };
    for (const [id, point] of Object.entries(positions)) { const next = nextPositions[id]; S[id] = { x: point.x * AU, y: point.y * AU, z: point.z * AU, vx: (next.x - point.x) * AU, vy: (next.y - point.y) * AU, vz: (next.z - point.z) * AU }; }
    for (const moon of D.bodies.filter(body => body.kind === 'major_moon')) {
      const [point, next] = await Promise.all([ExolineOrbit.moon(moon.id, date), ExolineOrbit.moon(moon.id, nextDate)]), parent = D.bodies.find(body => body.name === moon.parent), host = S[parent.id];
      S[moon.id] = { x: host.x + point.x * AU, y: host.y + point.y * AU, z: host.z + point.z * AU, vx: host.vx + (next.x - point.x) * AU, vy: host.vy + (next.y - point.y) * AU, vz: host.vz + (next.z - point.z) * AU };
    }
  }
  function radiusOf(body) { return Math.max(1.3, P.bodies[body.id].radius_m * cam.k); }
  function orbit(id) {
    const body = D.bodies.find(item => item.id === id), parent = body?.parent && S[D.bodies.find(item => item.name === body.parent).id];
    const points = id.includes(':') ? ExolineOrbit.moonOrbitPath(id, 192, date) : ExolineOrbit.orbitPath(id, 384, date);
    X.beginPath(); points.forEach((point, index) => { const p = ws({ x: point.x * AU + (parent?.x || 0), y: point.y * AU + (parent?.y || 0) }); index ? X.lineTo(p.x, p.y) : X.moveTo(p.x, p.y); }); X.closePath(); X.strokeStyle = id === sel?.id ? '#78e5ff' : 'rgba(110,170,190,.20)'; X.lineWidth = id === sel?.id ? 1.5 : .7; X.stroke();
  }
  function body(body, point) {
    const screen = ws(point), radius = radiusOf(body), anchor = A[body.id] || A.default || { anchor_x: .5, anchor_y: .5 }, physical = P.bodies[body.id], sprite = img(body.orbital_asset);
    const surfacePx = physical ? physical.radius_m * cam.k : radius;
    // diskFraction: fraction of the sprite half-width occupied by the planet
    // disk (the rest is rings/glow). Scaling by it makes the sprite's disk
    // pixel radius exactly radius_m * cam.k, so the disk edge coincides with
    // the surface border and the collision radius.
    const diskFraction = Math.min(1, Math.max(0.05, (A[body.id] && A[body.id].diskFraction) || 1.0));
    const drawHalfSize = surfacePx / diskFraction;
    if (sprite.complete && sprite.naturalWidth) { X.save(); X.translate(screen.x, screen.y); X.rotate(rotationAngle(body)); X.drawImage(sprite, -drawHalfSize * 2 * anchor.anchor_x, -drawHalfSize * 2 * anchor.anchor_y, drawHalfSize * 2, drawHalfSize * 2); X.restore(); }
    else { X.fillStyle = '#94abb4'; X.beginPath(); X.arc(screen.x, screen.y, radius, 0, Math.PI * 2); X.fill(); }
    if (body.id !== 'sun' && radius > 2) {
      // Shadow anchor: for moons, the com moves around the host on the rendered
      // surrogate orbit, so a sunward/interplanetary light direction (host-less
      // vector) is only loosely meaningful; using the radial from the host keeps
      // the phase terminator consistent with the rendered orbit.
      const hostPoint = body.parent && S[D.bodies.find(b => b.id === body.parent)?.id] || null;
      const length = hostPoint ? Math.hypot(point.x - hostPoint.x, point.y - hostPoint.y) || 1 : (Math.hypot(point.x, point.y) || 1);
      const lx = hostPoint ? -(point.x - hostPoint.x) / length : -point.x / length;
      const ly = hostPoint ? (point.y - hostPoint.y) / length : point.y / length;
      const night = X.createLinearGradient(screen.x - lx * radius * 1.35, screen.y - ly * radius * 1.35, screen.x + lx * radius * 1.35, screen.y + ly * radius * 1.35);
      night.addColorStop(0, 'rgba(0,2,9,.96)'); night.addColorStop(.42, 'rgba(0,4,14,.78)'); night.addColorStop(.56, 'rgba(2,10,20,.20)'); night.addColorStop(.68, 'rgba(0,0,0,0)');
      X.save(); X.beginPath(); X.arc(screen.x, screen.y, radius, 0, Math.PI * 2); X.clip(); X.fillStyle = night; X.fillRect(screen.x - radius, screen.y - radius, radius * 2, radius * 2); X.restore();
    }
    // Thin surface border for solid-surface bodies: exactly one physical radius
    // in screen space, coincident with the collision / landing radius. Gas
    // bodies get no border.
    if (physical && physical.solidSurface && surfacePx >= 6) {
      X.save();
      X.strokeStyle = 'rgba(180,220,255,0.5)';
      X.lineWidth = 1;
      X.beginPath();
      X.arc(screen.x, screen.y, surfacePx, 0, Math.PI * 2);
      X.stroke();
      X.restore();
    }
    if (radius > 12 || sel?.id === body.id) { X.fillStyle = '#e8f8ff'; X.font = '10px sans-serif'; X.fillText(body.name, screen.x + radius + 5, screen.y - 4); }
  }
  function marker(world, label, colour) { const p = ws(world); X.fillStyle = colour; X.beginPath(); X.arc(p.x, p.y, 4, 0, Math.PI * 2); X.fill(); X.fillStyle = '#e7f9ff'; X.font = '9px sans-serif'; X.fillText(label, p.x + 7, p.y - 7); }
  // Sphere-of-influence envelope for every body: a green rim with a faint
  // green fill. Radius is the physical Hill sphere (a(1-e)·(m/3M)^(1/3)), so
  // the rim marks where the body's gravity actually dominates its primary's.
  // Cross the rim on a trajectory and the patched-conic prediction switches
  // to the full N-body dotted path (see trajectory()).
  function drawSoiCircles() {
    if (!D || !P) return;
    X.save();
    for (const body of D.bodies) {
      if (body.id === 'sun') continue;
      const point = S[body.id];
      const physical = P.bodies[body.id];
      if (!point || !physical) continue;
      const soi = ExolineNav.soiRadius(body.id);
      if (!finite(soi) || soi <= physical.radius_m) continue;
      const screen = ws(point), radiusPx = soi * cam.k;
      if (radiusPx < 4) continue;                                        // smaller than the body dot
      if (radiusPx > 3 * Math.max(innerWidth, innerHeight)) continue;    // far off-screen
      X.beginPath(); X.arc(screen.x, screen.y, radiusPx, 0, Math.PI * 2);
      X.fillStyle = 'rgba(74,222,128,.055)';
      X.fill();
      X.lineWidth = 1;
      X.strokeStyle = 'rgba(74,222,128,.42)';
      X.stroke();
    }
    X.restore();
  }
  function drawHyperbolicArc(id, r, v, R, mu, h, e, p, ex, physical) {
    // Analytic hyperbola branch in the PLANET frame: craft -> SOI exit (or
    // screen edge for the sun). Exact 2-body math, stable at every warp.
    const origin = S[id];
    const dir = h >= 0 ? 1 : -1, perp = { x: -ex.y, y: ex.x };
    const nu = Math.atan2(r.x * perp.x + r.y * perp.y, r.x * ex.x + r.y * ex.y);
    const soi = (id && id !== 'sun' && window.ExolineNav) ? ExolineNav.soiRadius(id) : null;
    const span = Math.hypot(innerWidth, innerHeight) * 1.25 / cam.k;
    const exitR = (soi && finite(soi) && soi > R) ? soi : R + span;
    const cosExit = (p / exitR - 1) / Math.max(e, 1e-9);
    const fwd = (a, b) => { let d = dir > 0 ? b - a : a - b; while (d < 0) d += Math.PI * 2; return d; };
    let travel = Infinity, ok = Math.abs(cosExit) <= 1;
    if (ok) {
      for (const c of [Math.acos(Math.max(-1, Math.min(1, cosExit))), -Math.acos(Math.max(-1, Math.min(1, cosExit)))]) {
        const d = fwd(nu, c);
        if (d > 1e-6 && d < travel) travel = d;
      }
      if (!finite(travel)) ok = false;
    }
    X.save(); X.setLineDash([7, 6]); X.strokeStyle = 'rgba(255,192,115,.92)'; X.lineWidth = 1.5; X.beginPath();
    if (ok) {
      const NH = smoothCount(travel * (R + exitR) / 2, 48, 512);
      for (let i = 0; i <= NH; i++) {
        const th = nu + dir * travel * i / NH, rad = p / (1 + e * Math.cos(th));
        const pt = ws({ x: origin.x + rad * (Math.cos(th) * ex.x + Math.sin(th) * perp.x), y: origin.y + rad * (Math.cos(th) * ex.y + Math.sin(th) * perp.y) });
        i ? X.lineTo(pt.x, pt.y) : X.moveTo(pt.x, pt.y);
      }
    } else {
      // Degenerate (near-parabolic): straight asymptote ray, planet-relative.
      const speed = Math.hypot(v.x, v.y) || 1;
      const a = ws(F.s.r), b = ws({ x: F.s.r.x + v.x / speed * span, y: F.s.r.y + v.y / speed * span });
      X.moveTo(a.x, a.y); X.lineTo(b.x, b.y);
    }
    X.stroke(); X.setLineDash([]); X.restore();
    const peri = p / (1 + e);
    marker({ x: origin.x + peri * ex.x, y: origin.y + peri * ex.y }, `PE ${altitude(peri - physical.radius_m)}`, '#77edff');
    if (ok && soi && finite(soi) && soi > R) {
      const th = nu + dir * travel;
      marker({ x: origin.x + exitR * (Math.cos(th) * ex.x + Math.sin(th) * perp.x), y: origin.y + exitR * (Math.cos(th) * ex.y + Math.sin(th) * perp.y) }, 'SOI EXIT', '#ffcf9c');
    } else if (ok) {
      const th = nu + dir * travel;
      const end = ws({ x: origin.x + exitR * (Math.cos(th) * ex.x + Math.sin(th) * perp.x), y: origin.y + exitR * (Math.cos(th) * ex.y + Math.sin(th) * perp.y) });
      X.fillStyle = '#ffcf9c'; X.font = '9px sans-serif'; X.fillText('ESCAPE', end.x - 42, end.y - 8);
    }
  }
  // Plan-version of drawHyperbolicArc: draws the hyperbolic escape arc for a
  // planned maneuver node, using the plan's final state and the live body pos.
  function drawHyperbolicArcPlan(refId, rRel, vRel, R, mu, h, e, p, physical, origin, plan) {
    // Compute eccentricity vector from state
    const rv = rRel.x * vRel.x + rRel.y * vRel.y;
    const V2 = vRel.x * vRel.x + vRel.y * vRel.y;
    const ev = { x: (((V2 - mu / R) * rRel.x - rv * vRel.x) / mu), y: (((V2 - mu / R) * rRel.y - rv * vRel.y) / mu) };
    const ex = e > 1e-6 ? { x: ev.x / e, y: ev.y / e } : { x: rRel.x / R, y: rRel.y / R };
    const dir = h >= 0 ? 1 : -1, perp = { x: -ex.y, y: ex.x };
    const nu = Math.atan2(rRel.x * perp.x + rRel.y * perp.y, rRel.x * ex.x + rRel.y * ex.y);
    const soi = ExolineNav.soiRadius(refId);
    const span = Math.hypot(innerWidth, innerHeight) * 1.25 / cam.k;
    const exitR = (soi && finite(soi) && soi > R) ? soi : R + span;
    const cosExit = (p / exitR - 1) / Math.max(e, 1e-9);
    const fwd = (a, b) => { let d = dir > 0 ? b - a : a - b; while (d < 0) d += Math.PI * 2; return d; };
    let travel = Infinity, ok = Math.abs(cosExit) <= 1;
    if (ok) {
      for (const c of [Math.acos(Math.max(-1, Math.min(1, cosExit))), -Math.acos(Math.max(-1, Math.min(1, cosExit)))]) {
        const d = fwd(nu, c);
        if (d > 1e-6 && d < travel) travel = d;
      }
      if (!finite(travel)) ok = false;
    }
    X.save(); X.setLineDash([7, 6]); X.strokeStyle = 'rgba(255,192,115,.92)'; X.lineWidth = 1.5; X.beginPath();
    if (ok) {
      const NH = smoothCount(travel * (R + exitR) / 2, 48, 512);
      for (let i = 0; i <= NH; i++) {
        const th = nu + dir * travel * i / NH, rad = p / (1 + e * Math.cos(th));
        const pt = ws({ x: origin.x + rad * (Math.cos(th) * ex.x + Math.sin(th) * perp.x), y: origin.y + rad * (Math.cos(th) * ex.y + Math.sin(th) * perp.y) });
        i ? X.lineTo(pt.x, pt.y) : X.moveTo(pt.x, pt.y);
      }
    } else {
      const speed = Math.hypot(vRel.x, vRel.y) || 1;
      const a = ws({ x: origin.x + rRel.x, y: origin.y + rRel.y }), b = ws({ x: origin.x + rRel.x + vRel.x / speed * span, y: origin.y + rRel.y + vRel.y / speed * span });
      X.moveTo(a.x, a.y); X.lineTo(b.x, b.y);
    }
    X.stroke(); X.setLineDash([]); X.restore();
    const peri = p / (1 + e);
    marker({ x: origin.x + peri * ex.x, y: origin.y + peri * ex.y }, `PE ${altitude(peri - physical.radius_m)}`, '#77edff');
    if (ok && soi && finite(soi) && soi > R) {
      const th = nu + dir * travel;
      marker({ x: origin.x + exitR * (Math.cos(th) * ex.x + Math.sin(th) * perp.x), y: origin.y + exitR * (Math.cos(th) * ex.y + Math.sin(th) * perp.y) }, 'SOI EXIT', '#ffcf9c');
    } else if (ok) {
      const th = nu + dir * travel;
      const end = ws({ x: origin.x + exitR * (Math.cos(th) * ex.x + Math.sin(th) * perp.x), y: origin.y + exitR * (Math.cos(th) * ex.y + Math.sin(th) * perp.y) });
      X.fillStyle = '#ffcf9c'; X.font = '9px sans-serif'; X.fillText('ESCAPE', end.x - 42, end.y - 8);
    }
  }
  // Render the numerical coast prediction when a simple conic would be
  // misleading: atmospheric flight, surface impact, or SOI escape.  This is
  // generated by navigation-engine with the same RK4 + drag model as flight.
  // v0.1.3 atmosphere tint: each drawn segment keeps its vacuum color in
  // vacuum; where the segment midpoint sits in air, q at that point picks
  // the stroke (<2 kPa blue, <20 kPa amber, else red). Decimated points only.
  function tintForQ(qAt) {
    if (!(qAt > 0)) return null;
    if (qAt < 2000) return '#4aa3ff';
    if (qAt < 20000) return '#ffb347';
    return '#ff4444';
  }
  function qAtPoint(r, v, refId) {
    try {
      const body = S[refId], physical = P.bodies[refId];
      const atm = ExolineFlight.atmospheres && ExolineFlight.atmospheres[refId];
      if (!body || !physical || !atm) return 0;
      const rho = ExolineFlight.atmosphereDensity(r, { x: body.x, y: body.y, z: body.z || 0 }, { ...physical, id: refId }) || 0;
      if (!(rho > 0)) return 0;
      const vx = r && v ? (v.x - (body.vx || 0)) : 0, vy = r && v ? (v.y - (body.vy || 0)) : 0;
      const sp = Math.hypot(vx, vy);
      return sp > 0 ? 0.5 * rho * sp * sp : 0;
    } catch (e) { return 0; }
  }
  function drawNumericalCoast(leg, refId) {
    const records = leg?.records;
    if (!records || records.length < 2) return false;
    const physical = P.bodies[refId], origin = S[refId];
    if (!physical || !origin) return false;
    // Planet frame: frozen inertial records + live body position. rec.t is
    // seconds-since-build, so the body offset is sampled at each record's own
    // absolute time — no helical smear while the camera follows the planet.
    const worldAt = window.ExolineNav?._internals?.worldAt;
    const dtBuild = ((leg.builtAt || +date) - +date) / 1000;
    const rel = (pt, tSec) => {
      if (!worldAt || refId === 'sun') return { x: pt.x - origin.x, y: pt.y - origin.y };
      const bp = worldAt(refId, tSec);
      if (!bp) return null;
      return { x: pt.x - bp.x, y: pt.y - bp.y };
    };
    const stride = Math.max(1, Math.ceil(records.length / 250));
    const pts = [];
    for (let i = 0; i < records.length; i += stride) {
      const q = rel(records[i].r, records[i].t + dtBuild);
      if (q) pts.push(q);
    }
    const last = records[records.length - 1];
    const lastQ = rel(last.r, last.t + dtBuild);
    if (lastQ) pts.push(lastQ);
    if (pts.length < 2) return false;
    X.save(); X.lineWidth = 1.8; X.setLineDash([5, 5]);
    // v0.1.3 atmosphere tint over the SAME decimated points: stroke each
    // segment in its own color, midpoint q vs the leg reference body.
    const segIdx = i => records[Math.min(records.length - 1, i * stride)];
    const baseStyle = leg.impact ? '#ff7373' : '#ffc96d';
    let prev = ws({ x: origin.x + pts[0].x, y: origin.y + pts[0].y });
    X.strokeStyle = baseStyle; X.beginPath(); X.moveTo(prev.x, prev.y);
    for (let i = 1; i < pts.length; i++) {
      const p = ws({ x: origin.x + pts[i].x, y: origin.y + pts[i].y });
      const mid = segIdx(i);
      const tinted = tintForQ(qAtPoint(mid.r, mid.v, refId)) || baseStyle;
      if (tinted !== X.strokeStyle) { X.stroke(); X.strokeStyle = tinted; X.beginPath(); X.moveTo(prev.x, prev.y); }
      X.lineTo(p.x, p.y);
      prev = p;
      orbitHitRegions.push({ x: p.x, y: p.y, t: Math.max(1, mid.t) });
    }
    X.stroke(); X.setLineDash([]); X.restore();
    // The propagated path sits above body picking and is always a valid
    // place to offer a maneuver node, including an escape trajectory.
    if (leg.impact) {
      const lq = pts[pts.length - 1], scale = physical.radius_m / Math.max(1, Math.hypot(lq.x, lq.y));
      marker({ x: origin.x + lq.x * scale, y: origin.y + lq.y * scale }, 'IMPACT', '#ff7373');
    } else {
      // Label the endpoint only when the integrated arc is genuinely UNBOUND
      // relative to the reference body. A translunar injection is a huge but
      // still-bound ellipse (apoapsis near the Moon, specific energy < 0); the
      // old code stamped "ESCAPE" on every non-impact leg, which mislabeled a
      // normal Moon transfer and read as a broken prediction. Compute the end
      // state's specific energy and flag escape only when it is >= 0.
      const endR = leg.endState && leg.endState.r, endV = leg.endState && leg.endState.v;
      let unbound = false;
      if (endR && endV) {
        const rx = endR.x - origin.x, ry = endR.y - origin.y;
        const vx = endV.x - (origin.vx || 0), vy = endV.y - (origin.vy || 0);
        const R = Math.max(1, Math.hypot(rx, ry)), V2 = vx * vx + vy * vy, mu = P.G * physical.mass;
        unbound = (V2 / 2 - mu / R) >= 0;
      }
      if (unbound) {
        const lq = pts[pts.length - 1], end = ws({ x: origin.x + lq.x, y: origin.y + lq.y });
        X.fillStyle = '#ffcf9c'; X.font = '9px sans-serif'; X.fillText('ESCAPE', end.x + 7, end.y - 7);
      }
    }
    return true;
  }
  function trajectory() {
    if (!craftSelected || !F || !S.sun) return;
    const d = F.diagnostics(S, sel?.id), id = currentSoi?.id || d.body;
    if (!id || !S[id]) return;
    const physical = P.bodies[id];
    const r = { x: F.s.r.x - S[id].x, y: F.s.r.y - S[id].y };
    const v = { x: F.s.v.x - S[id].vx, y: F.s.v.y - S[id].vy };
    const R = Math.hypot(r.x, r.y), mu = P.G * physical.mass, h = r.x * v.y - r.y * v.x;
    const ev = { x: (((v.x * v.x + v.y * v.y) - mu / R) * r.x - (r.x * v.x + r.y * v.y) * v.x) / mu, y: (((v.x * v.x + v.y * v.y) - mu / R) * r.y - (r.x * v.x + r.y * v.y) * v.y) / mu };
    const e = Math.hypot(ev.x, ev.y), p = h * h / mu;
    if (!finite(e) || !finite(p)) return;
    const ex = e > .00001 ? { x: ev.x / e, y: ev.y / e } : { x: r.x / R, y: r.y / R };
    const peri = p / (1 + e), apo = p / (1 - e);
    // On-rails coast: orbit elements come from the frozen arc, bit-identical
    // every frame, so AP/PE/ecc and every branch below can never flicker.
    const frozen = F.coast && F.coast.body === id ? F.coast : null;
    let eF = e, pF = p, exF = ex, periF = peri, apoF = apo;
    if (frozen) {
      const pl = Math.hypot(frozen.Px, frozen.Py);
      if (pl > 1e-9) {
        eF = frozen.e; pF = frozen.a * (1 - frozen.e * frozen.e);
        exF = { x: frozen.Px / pl, y: frozen.Py / pl };
        periF = frozen.a * (1 - frozen.e);
        apoF = frozen.e < 1 ? frozen.a * (1 + frozen.e) : Infinity;
      }
    }
    const atmosphere = ExolineFlight.atmospheres?.[id];
    const inAtmosphere = atmosphere && R - physical.radius_m < atmosphere.top;
    const numerical = navSnap?.heavy?.base;
    // A closed osculating conic is only valid INSIDE the SOI: once the
    // apoapsis crosses the Hill radius, the primary's gravity dominates and
    // the full N-body dotted path takes over (patched-conic boundary), so
    // the trajectory stays physical past the green rim.
    const refSoi = (id && id !== 'sun') ? ExolineNav.soiRadius(id) : null;
    const crossesSoi = !!(refSoi && finite(refSoi) && apoF > refSoi);
    // A transfer that dips into ANOTHER body's sphere of influence is drawn
    // from the numerical N-body coast, not an osculating conic. Decide this from
    // the PREDICTION's own integrated path (navSnap.heavy.base), NOT the
    // frame-to-frame osculating apoapsis: near the target the osculating apsis
    // swings wildly, which flipped the drawn line between the ellipse and the
    // coast every frame — the "keeps varying" jitter. The prediction is rebuilt
    // on a steady cadence and is self-consistent, so its SOI reach is a stable
    // signal, and it is exactly the path captureCoast() lets the craft fly.
    let entersForeignSoi = false;
    if (!frozen && numerical && numerical.records && numerical.records.length > 1) {
      const worldAt = window.ExolineNav?._internals?.worldAt;
      const dtBuild = ((numerical.builtAt || +date) - +date) / 1000;
      const recs = numerical.records, stride = Math.max(1, Math.floor(recs.length / 120));
      outer:
      for (let i = 0; i < recs.length; i += stride) {
        const tSec = recs[i].t + dtBuild;
        for (const bid of Object.keys(P.bodies)) {
          if (bid === id || !S[bid]) continue;
          const p = P.bodies[bid];
          if (!p || !p.solidSurface) continue;
          const soiB = ExolineNav.soiRadius(bid);
          if (!soiB || !finite(soiB)) continue;
          // Skip parents: a body whose SOI already encloses the reference body
          // (e.g. Earth around the Moon) is normal, not a transfer boundary.
          if (Math.hypot(S[id].x - S[bid].x, S[id].y - S[bid].y) < soiB) continue;
          let bx, by;
          if (worldAt && bid !== 'sun') { const bp = worldAt(bid, tSec); if (!bp) continue; bx = bp.x; by = bp.y; }
          else { bx = S[bid].x; by = S[bid].y; }
          if (Math.hypot(recs[i].r.x - bx, recs[i].r.y - by) < soiB) { entersForeignSoi = true; break outer; }
        }
      }
    }
    // Do not substitute a vacuum ellipse/straight line for a drag, escape, or
    // SOI-crossing prediction.  The sampled curve also remains selectable for
    // ADD NODE.  Skipped on-rails: a clean coast arc can never impact, drag,
    // or exceed the SOI it was validated against when it was captured.
    if (numerical && (numerical.impact || eF >= 1 || inAtmosphere || crossesSoi || entersForeignSoi) && (!frozen || crossesSoi || entersForeignSoi)) {
      if (drawNumericalCoast(numerical, id)) {
        marker({ x: F.s.r.x, y: F.s.r.y }, 'CURRENT', '#ffbd76');
        return;
      }
    }
    if (periF <= physical.radius_m) {
      // An osculating orbit that intersects the body is an impact trajectory,
      // not a complete orbit. Draw only the forward arc to the surface.
      const perp = { x: -exF.y, y: exF.x };
      const nu = Math.atan2(r.x * perp.x + r.y * perp.y, r.x * exF.x + r.y * exF.y);
      const hitCos = Math.max(-1, Math.min(1, (pF / physical.radius_m - 1) / Math.max(eF, 1e-8)));
      const candidates = [Math.acos(hitCos), -Math.acos(hitCos)];
      const direction = h >= 0 ? 1 : -1;
      let hitNu = candidates[0], travel = Infinity;
      for (const candidate of candidates) {
        let delta = direction > 0 ? candidate - nu : nu - candidate;
        while (delta < 0) delta += Math.PI * 2;
        if (delta < travel) { travel = delta; hitNu = candidate; }
      }
      X.save(); X.strokeStyle = '#ff7373'; X.lineWidth = 1.8; X.setLineDash([5, 5]); X.beginPath();
      const NI = smoothCount(travel * (R + physical.radius_m) / 2, 48, 512);
      for (let i = 0; i <= NI; i++) {
        const theta = nu + direction * travel * i / NI, radial = pF / (1 + eF * Math.cos(theta));
        const point = ws({ x: S[id].x + radial * (Math.cos(theta) * exF.x + Math.sin(theta) * perp.x), y: S[id].y + radial * (Math.cos(theta) * exF.y + Math.sin(theta) * perp.y) });
        i ? X.lineTo(point.x, point.y) : X.moveTo(point.x, point.y);
      }
      X.stroke(); X.setLineDash([]); X.restore();
      const impact = { x: S[id].x + physical.radius_m * (Math.cos(hitNu) * exF.x + Math.sin(hitNu) * perp.x), y: S[id].y + physical.radius_m * (Math.cos(hitNu) * exF.y + Math.sin(hitNu) * perp.y) };
      marker({ x: F.s.r.x, y: F.s.r.y }, 'CURRENT', '#ffbd76');
      marker(impact, 'IMPACT', '#ff7373');
      return;
    }
    if (eF >= 1) { drawHyperbolicArc(id, r, v, R, mu, h, eF, pF, exF, physical); marker({ x: F.s.r.x, y: F.s.r.y }, 'CURRENT', '#ffbd76'); return; }
    // Closed conic: draw the full predicted orbit around the SOI body, in the
    // body's local frame, so the trajectory reads as an orbit around the planet
    // the craft is entering -- not as a wavy line in the solar-system frame.
    // The ellipse is rendered in screen space via ws() so it stays visible at
    // any zoom; the perigee/apogee markers sit on the same ellipse centre.
    // Shape comes from the frozen coast arc when on-rails: pixel-identical.
    const a = pF / (1 - eF * eF), b = a * Math.sqrt(Math.max(0, 1 - eF * eF)), cc = a * eF, perp = { x: -exF.y, y: exF.x };
    const N = smoothCount(ellipsePerimeter(a, b), 96, 2048), hitStride = Math.max(1, Math.floor(N / 256));
    const origin = { x: S[id].x, y: S[id].y };
    const cx = { x: origin.x - cc * exF.x, y: origin.y - cc * exF.y };
    X.save();
    X.beginPath();
    const period = 2 * Math.PI * Math.sqrt(a ** 3 / mu), currentNu = Math.atan2(r.x * perp.x + r.y * perp.y, r.x * exF.x + r.y * exF.y), direction = h >= 0 ? 1 : -1;
    for (let i = 0; i <= N; i++) {
      const th = (2 * Math.PI * i) / N;
      const px = cx.x + a * Math.cos(th) * exF.x + b * Math.sin(th) * perp.x;
      const py = cx.y + a * Math.cos(th) * exF.y + b * Math.sin(th) * perp.y;
      const screen = ws({ x: px, y: py });
      if (i % hitStride === 0) {
        let phase = direction > 0 ? th - currentNu : currentNu - th; while (phase < 0) phase += Math.PI * 2;
        orbitHitRegions.push({ x: screen.x, y: screen.y, t: Math.max(30, phase / (Math.PI * 2) * period) });
      }
      i ? X.lineTo(screen.x, screen.y) : X.moveTo(screen.x, screen.y);
    }
    X.closePath();
    X.strokeStyle = '#78e5ff';
    X.lineWidth = 1.6;
    X.stroke();
    X.restore();
    // The apses are measured from the ellipse centre by its semi-major axis;
    // peri/apo are distances from the focus, so using them here misplaces both.
    const periPoint = { x: cx.x + a * exF.x, y: cx.y + a * exF.y };
    const apoPoint = { x: cx.x - a * exF.x, y: cx.y - a * exF.y };
    marker(periPoint, `PE ${altitude(periF - physical.radius_m)}`, '#77edff');
    marker(apoPoint, `AP ${altitude(apoF - physical.radius_m)}`, '#ffbd76');
  }
  // v0.1.3 landing-prediction marker. Uses the SAME base.records the coast
  // line draws: last impact record, surface-projected onto the impact body.
  // Drawn only over solid bodies whose on-screen radius clears 4 px — gas
  // bodies get the nav-panel PASS-THROUGH line instead of a marker.
  function impactMarker() {
    if (!craftSelected || !F || !S.sun || !navSnap || !navSnap.heavy) return;
    const base = navSnap.heavy.base;
    if (!base || base.impact !== true || !base.impactBodyId || !base.records || !base.records.length) return;
    const id = base.impactBodyId, body = S[id], physical = P.bodies && P.bodies[id];
    if (!body || !physical || physical.solidSurface === false) return;
    const screenR = Math.max(1, physical.radius_m * cam.k);
    if (screenR < 4) return;
    const last = base.records[base.records.length - 1];
    const dx = last.r.x - body.x, dy = last.r.y - body.y;
    const m = Math.hypot(dx, dy);
    if (!(m > 0)) return;
    const surf = { x: body.x + dx / m * physical.radius_m, y: body.y + dy / m * physical.radius_m };
    const p = ws(surf);
    X.save(); X.strokeStyle = '#ff5555'; X.lineWidth = 1;
    X.beginPath();
    X.moveTo(p.x - 8, p.y); X.lineTo(p.x + 8, p.y);
    X.moveTo(p.x, p.y - 8); X.lineTo(p.x, p.y + 8);
    X.stroke();
    X.beginPath(); X.arc(p.x, p.y, 5, 0, Math.PI * 2); X.stroke();
    X.fillStyle = '#ff5555'; X.font = '9px sans-serif';
    X.fillText('IMPACT', p.x + 10, p.y - 8);
    X.restore();
  }
  function craft() { if (!F) return; const p = ws(F.s.r); X.save(); X.translate(p.x, p.y); X.rotate(-F.s.heading + Math.PI / 2); X.fillStyle = '#f8fdff'; X.strokeStyle = '#0b3040'; X.lineWidth = 2; X.beginPath(); X.moveTo(0, -15); X.lineTo(11, 11); X.lineTo(-11, 11); X.closePath(); X.fill(); X.stroke(); X.fillStyle = '#53ddff'; X.beginPath(); X.moveTo(0, -8); X.lineTo(3, 3); X.lineTo(-3, 3); X.closePath(); X.fill(); X.restore(); }
  function hud() { $('flightHud').classList.toggle('hidden', !craftSelected); if (!craftSelected || !F) return; const d = F.diagnostics(S, sel?.id), name = D.bodies.find(b => b.id === d.body)?.name || 'Sun', radius = P.bodies[d.body]?.radius_m || 0; const fr = F.coast && F.coast.body === d.body ? F.coast : null, ecc = fr ? fr.e : d.e, apo = fr ? (fr.e < 1 ? fr.a * (1 + fr.e) : Infinity) : d.apo, peri = fr ? fr.a * (1 - fr.e) : d.peri; $('hudSoi').textContent = name.toUpperCase(); $('hudAlt').textContent = d.alt < 10000 ? `${Math.round(d.alt)} m` : `${(d.alt / 1000).toFixed(1)} km`; $('hudVel').textContent = d.speed < 1000 ? `${d.speed.toFixed(1)} m/s` : `${Math.round(d.speed).toLocaleString('en-US')} m/s`; $('hudApo').textContent = altitude(apo - radius); $('hudPeri').textContent = altitude(peri - radius); $('hudEcc').textContent = ecc.toFixed(4); $('hudDistance').textContent = altitude(d.target); $('launchBtn').textContent = F.s.throttle > 0 ? 'CUTOFF' : 'IGNITION'; $('ascentBtn').classList.toggle('is-on', !!F.ascentMode); $('ascentBtn').setAttribute('aria-pressed', String(!!F.ascentMode)); descentHudSync(); updateBurnReadout();

    // Reentry HUD
    const rs = F.reentryState;
    if (rs.bodyId && rs.phase !== 'EXO') {
      const bodyName = D.bodies.find(b => b.id === rs.bodyId)?.name || rs.bodyId;
      $('hudReentry').textContent = `${bodyName} ${rs.phase}  q=${(rs.q || 0).toFixed(1)}  g=${rs.gLoad.toFixed(2)}  alt=${altitude(rs.alt)}`;
      $('hudReentry').classList.remove('hidden');
    } else {
      $('hudReentry').classList.add('hidden');
    }
    // v0.1.2 thermal + chute telemetry (same throttled hud() cadence).
    // v0.1.3: while descent guidance owns the throttle, mirror it on the
    // dial with an AUTO tag (like auto-burn does) so the deck reads honestly.
    if (F.descentMode) { const lvl = Math.round(F.s.throttle * 100); $('throttle').value = String(lvl); $('throttleReadout').textContent = `${lvl}% · AUTO`; $('throttleDial').style.setProperty('--lvl', lvl); }
    if (F.reentryState.aerocapturePing) { F.reentryState.aerocapturePing = false; showToast('AEROCAPTURE: BOUND ORBIT'); }
    thermalReadout();
    atmoReadout();
    calloutCheck();
    impactPanelSync();
  }
  // v0.1.2: skin-temperature bar (0-3000 K; amber past 1500 K, red past
  // 2500 K), SHIELDED/EXPOSED while inside air, STOWED/DEPLOYED/LOST chute.
  // Shown only when it means something: in-air, chute out, or the skin is
  // above ambient. Guards every lookup so a missing node can't break hud().
  function thermalReadout() {
    if (!F) return;
    const box = $('hudThermal'), fill = $('hudTempFill'), val = $('hudTempVal'), shieldEl = $('hudShield'), chuteEl = $('hudChute');
    if (!box || !fill || !val || !shieldEl || !chuteEl) return;
    const T = Number.isFinite(F.s.temperature) ? F.s.temperature : 290;
    const inAir = Number(F.reentryState && F.reentryState.rho) > 0;
    const show = inAir || !!F.s.chuteDeployed || T > 302;
    box.classList.toggle('hidden', !show);
    if (!show) return;
    fill.style.width = Math.max(0, Math.min(100, T / 3000 * 100)).toFixed(1) + '%';
    const warn = T > 1500 && T <= 2500, crit = T > 2500;
    fill.classList.toggle('warn', warn);
    fill.classList.toggle('crit', crit);
    val.textContent = `${Math.round(T)} K`;
    val.classList.toggle('hot', warn);
    val.classList.toggle('crit', crit);
    if (inAir) {
      shieldEl.textContent = F.s.shieldFacing ? 'SHIELDED' : 'EXPOSED';
      shieldEl.className = F.s.shieldFacing ? 'ok' : 'bad';
    } else { shieldEl.textContent = '—'; shieldEl.className = ''; }
    if (F.s.chuteDeployed && F.s.chuteAlive) { chuteEl.textContent = 'DEPLOYED'; chuteEl.className = 'ok'; }
    else if (F.s.chuteDeployed) { chuteEl.textContent = 'LOST'; chuteEl.className = 'bad'; }
    else { chuteEl.textContent = 'STOWED'; chuteEl.className = ''; }
    syncChuteBtn();
  }
  // v0.1.3 descent guidance UI: one toggle point for the keybind and the
  // DESCENT button. Enabling cancels an active auto-burn (the engine cannot
  // serve two throttles) and excludes ascent mode; the engine owns the gas
  // refusal. While active the button shows the controlled is-on state.
  function toggleDescentMode() {
    if (!F) return;
    if (!F.descentMode) {
      if (autoBurn) { cancelAutoBurn('AUTO-BURN CANCELLED: DESCENT MODE'); }
      F.ascentMode = false;
      const ok = F.setDescentMode(true);
      showToast(ok ? 'DESCENT MODE ON' : 'DESCENT MODE UNAVAILABLE');
      syncDescentBtn();
      return;
    }
    F.setDescentMode(false);
    showToast('DESCENT MODE OFF');
    syncDescentBtn();
  }
  // v0.1.3: per-hud() descent bookkeeping. Syncs the DESCENT button with
  // engine-side disarms (touchdown, fuel-out) and surfaces the one-shot
  // fuel-out abort toast. Called on the existing throttled hud() cadence —
  // no extra timers, no extra physics.
  function descentHudSync() {
    if (!F) return;
    syncDescentBtn();
    if (F.descentAbort) { F.descentAbort = false; showToast('DESCENT ABORT: NO FUEL'); }
  }
  // v0.1.3 shared descent-frame math. Resolves the dominant SOLID body's
  // radius/altitude, body-relative velocity, radial + horizontal splits, air
  // density, q, mach and g-load off the live body map S. Returns null when
  // no solid reference frame exists (deep space / gas body), in which case
  // callers show dashes instead of telemetry.
  function descentFrame() {
    if (!F || !S) return null;
    let refId = null;
    try { refId = (typeof F.referenceBody === 'function') ? F.referenceBody(S, F.s) : null; } catch (e) { refId = null; }
    const body = refId && S[refId], physical = refId && P.bodies[refId];
    if (!body || !physical || physical.solidSurface === false) return null;
    const rx = F.s.r.x - body.x, ry = F.s.r.y - body.y, rz = (F.s.r.z || 0) - (body.z || 0);
    const d = Math.hypot(rx, ry, rz);
    if (!(d > 0)) return null;
    const nx = rx / d, ny = ry / d;
    const vvx = F.s.v.x - (body.vx || 0), vvy = F.s.v.y - (body.vy || 0);
    const vSpeed = Math.hypot(vvx, vvy);
    const radial = (vvx * nx + vvy * ny);
    const vDown = Math.max(0, -radial);
    const h = d - physical.radius_m;
    let rho = 0;
    try { rho = ExolineFlight.atmosphereDensity(F.s.r, { x: body.x, y: body.y, z: body.z || 0 }, { ...physical, id: refId }) || 0; } catch (e) { rho = 0; }
    const q = rho > 0 && vSpeed > 0 ? 0.5 * rho * vSpeed * vSpeed : 0;
    let mach = null;
    const ss = ExolineFlight.atmospheres && ExolineFlight.atmospheres[refId] && ExolineFlight.atmospheres[refId].soundSpeed;
    if (rho > 0 && ss > 0) mach = vSpeed / ss;
    const gLoad = F.reentryState ? (Number(F.reentryState.gLoad) || 0) : 0;
    return { refId, body, physical, d, nx, ny, vvx, vvy, vSpeed, radial, vDown, h, rho, q, mach, gLoad };
  }
  function syncDescentBtn() {
    if (!F) return;
    const btn = $('descentBtn');
    if (!btn) return;
    const on = !!F.descentMode;
    btn.classList.toggle('is-on', on);
    btn.setAttribute('aria-pressed', String(on));
  }
  // v0.1.3 descent + atmospheric telemetry, same throttled hud() cadence:
  // signed VS (color-banded), flight-path angle, Mach (in-air only), G, and
  // the q bar 0..100 kPa with a maxQ tick that flashes on a new >1 kPa peak.
  function atmoReadout() {
    const el = { vs: $('hudVs'), fpa: $('hudFpa'), mach: $('hudMach'), g: $('hudG'), q: $('hudQ'), fill: $('hudQFill'), tick: $('hudQTick') };
    if (!el.vs || !el.fpa || !el.mach || !el.g || !el.q || !el.fill || !el.tick) return;
    const fr = descentFrame();
    if (!fr) {
      el.vs.textContent = '—'; el.fpa.textContent = '—'; el.mach.textContent = '—';
      el.g.textContent = '—'; el.q.textContent = '—';
      el.fill.style.width = '0%'; el.fill.className = ''; el.tick.style.left = '0%';
      el.vs.className = '';
      return;
    }
    const vs = -fr.radial; // +up / -down, m/s
    const av = Math.abs(vs);
    el.vs.textContent = `${vs >= 0 ? '+' : ''}${vs.toFixed(1)} m/s`;
    el.vs.className = av < 2 ? 'hud-vs-ok' : av < 10 ? 'hud-vs-warn' : 'hud-vs-bad';
    const fpa = fr.vSpeed > 0.5 ? Math.asin(Math.max(-1, Math.min(1, (fr.vvx * fr.nx + fr.vvy * fr.ny) / fr.vSpeed))) * 180 / Math.PI : 0;
    el.fpa.textContent = `${fpa >= 0 ? '+' : ''}${fpa.toFixed(1)}°`;
    el.mach.textContent = fr.mach === null ? '—' : `${fr.mach.toFixed(1)}`;
    el.g.textContent = `${fr.gLoad.toFixed(1)} g`;
    const qShow = Number.isFinite(fr.q) ? fr.q : 0;
    el.q.textContent = qShow < 1000 ? `${qShow.toFixed(0)} Pa` : `${(qShow / 1000).toFixed(1)} kPa`;
    el.fill.style.width = Math.max(0, Math.min(100, qShow / 100000 * 100)).toFixed(1) + '%';
    el.fill.className = qShow >= 20000 ? 'q-hot' : qShow >= 2000 ? 'q-warm' : '';
    const mq = Number.isFinite(F.maxQ) ? F.maxQ : 0;
    el.tick.style.left = Math.max(0, Math.min(100, mq / 100000 * 100)).toFixed(1) + '%';
    if (mq > 1000 && (atmoReadout._lastMaxQ || 0) < mq) {
      const bar = el.fill.parentElement;
      if (bar) { bar.classList.remove('q-flash'); void bar.offsetWidth; bar.classList.add('q-flash'); }
    }
    atmoReadout._lastMaxQ = mq;
  }
  // v0.1.3 threshold callouts: one toast + flashing HUD chip per crossing.
  // Each key latches while its condition holds; the latch clears only after
  // 5 s continuously quiet, which is the re-arm in the spec.
  const calloutLatch = { sink: 0, terrain: 0, fuel: 0, over: 0 };
  function fireCallout(key, text) {
    if (calloutLatch[key + 'On']) return;
    calloutLatch[key + 'On'] = true;
    calloutLatch[key] = performance.now();
    showToast(text);
    const chip = $('hudCallout');
    if (chip) { chip.textContent = text; chip.classList.remove('hidden'); }
    clearTimeout(fireCallout._t);
    fireCallout._t = setTimeout(() => { const c = $('hudCallout'); if (c) c.classList.add('hidden'); }, 2300);
  }
  function clearCallout(key) {
    if (!calloutLatch[key + 'On']) return;
    if (performance.now() - (calloutLatch[key + '_off'] || 0) < 5000 && (calloutLatch[key + '_off'] || 0) > 0) return;
    calloutLatch[key + 'On'] = false;
  }
  function calloutCheck() {
    const fr = descentFrame();
    if (!F || !fr || F.s.landed || F.s.crashed) {
      calloutLatch.sinkOn = calloutLatch.terrainOn = calloutLatch.fuelOn = calloutLatch.overOn = false;
      return;
    }
    // Off-timers: stamp when each condition goes quiet; a latch re-arms 5 s
    // after its condition last held.
    const stamp = (key, holds) => {
      if (holds) { calloutLatch[key + '_off'] = 0; return; }
      if (!calloutLatch[key + '_off']) calloutLatch[key + '_off'] = performance.now();
      if (performance.now() - calloutLatch[key + '_off'] >= 5000) calloutLatch[key + 'On'] = false;
    };
    const sinkHolds = fr.vDown > 10 && fr.h < 100;
    const terrHolds = fr.h < 500 && fr.vDown > 30;
    const stage = F.stages && F.stages[F.currentStage];
    const cap = stage ? Number(stage.propellant) || 0 : 0;
    const fuelHolds = cap > 0 && F.s.propellant < 0.10 * cap && F.s.throttle > 0;
    const overHolds = fr.mach !== null && fr.mach > 5 && fr.rho > 0.3;
    if (sinkHolds) fireCallout('sink', 'SINK RATE'); else stamp('sink', false);
    if (terrHolds) fireCallout('terrain', 'TERRAIN'); else stamp('terrain', false);
    if (fuelHolds) fireCallout('fuel', 'LOW FUEL'); else stamp('fuel', false);
    if (overHolds) fireCallout('over', 'OVERSPEED'); else stamp('over', false);
  }
  // Keep the CHUTE button's pressed state in step with the flight state after
  // deploys, jettisons, loads, and fresh launches.
  function syncChuteBtn() {
    if (!F) return;
    const btn = $('chuteBtn');
    if (!btn) return;
    const live = !!(F.s.chuteDeployed && F.s.chuteAlive);
    btn.classList.toggle('is-on', live);
    btn.setAttribute('aria-pressed', String(live));
  }
  // v0.1.3 landing/impact prediction readout, piggybacked on navSnap — the
  // SAME heavy.base the trajectory renderer draws, so the line always agrees.
  // IMPACT <name> T-<dur> v=<speed>; gas pass-throughs read PASS-THROUGH
  // <name> depth <km>; clean horizons read NO IMPACT. While powered (any
  // throttle, descent or ascent guidance) the coast assumption is flagged
  // with a (COAST) suffix since it is not the powered outcome.
  function impactPanelSync() {
    const el = $('navImpact');
    if (!el || !navSnap || !navSnap.heavy) return;
    const base = navSnap.heavy.base;
    if (!base || !base.records || !base.records.length) { setText('navImpact', '—'); return; }
    const coastNote = (F && (F.s.throttle > 0 || F.descentMode || F.ascentMode)) ? ' (COAST)' : '';
    const physOf = id => (P.bodies && P.bodies[id]) || null;
    if (base.impact && base.impactBodyId && physOf(base.impactBodyId)) {
      const id = base.impactBodyId, phys = physOf(id);
      const recs = base.records, last = recs[recs.length - 1];
      const bv = (S[id] && Number.isFinite(S[id].vx)) ? { x: S[id].vx, y: S[id].vy } : { x: 0, y: 0 };
      const vrel = Math.hypot(last.v.x - bv.x, last.v.y - bv.y);
      const dtImpact = Math.max(0, (base.tEnd || 0));
      el.textContent = `IMPACT ${ExolineNav.bodyName(id).toUpperCase()} T-${ExolineNav.fmtDur(dtImpact)} v=${ExolineNav.fmtSpeed(vrel)}${coastNote}`;
      return;
    }
    // Gas-body pass-through: deepest dip of the leg below the cloud tops.
    if (!base.impact) {
      let best = null; // { id, depth }
      for (const rec of base.records) {
        for (const bid of Object.keys(P.bodies || {})) {
          const phys = physOf(bid);
          if (!phys || phys.solidSurface !== false || !S[bid]) continue;
          const atm = ExolineFlight.atmospheres && ExolineFlight.atmospheres[bid];
          if (!atm) continue;
          const rr = Math.hypot(rec.r.x - S[bid].x, rec.r.y - S[bid].y);
          const alt = rr - phys.radius_m;
          if (alt < atm.top) {
            const depth = atm.top - alt;
            if (!best || depth > best.depth) best = { id: bid, depth };
          }
        }
      }
      if (best) {
        el.textContent = `PASS-THROUGH ${ExolineNav.bodyName(best.id).toUpperCase()} depth ${(best.depth / 1000).toFixed(1)} km${coastNote}`;
        return;
      }
    }
    el.textContent = 'NO IMPACT IN HORIZON';
  }
  // Burn progress lives in the HUD (always visible with the craft selected) so
  // a collapsed navigation panel can never hide the auto-burn progress.
  function updateBurnReadout() {
    const box = $('hudBurn'), fill = $('hudBurnFill'), label = $('hudBurnText');
    if (!box || !fill || !label) return;
    const node = autoBurn ? (ExolineNav.getNodes().find(n => n.id === autoBurn.nodeId) || null) : null;
    if (!autoBurn || !node) { box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    const total = node.totalDv || 0, done = Math.min(autoBurn.delivered || 0, total);
    const pct = total > 0 ? Math.max(0, Math.min(100, done / total * 100)) : 0;
    fill.style.width = pct.toFixed(1) + '%';
    if (autoBurn.phase === 'BURN') {
      const accel = F.thrust / Math.max(F.s.m, 1);
      label.textContent = `BURN ${pct.toFixed(0)}%  T−${ExolineNav.fmtDur(Math.max(0, total - done) / Math.max(accel, 1e-9))} LEFT`;
    } else if (autoBurn.phase === 'ALIGN') {
      label.textContent = `ALIGNING  T−${ExolineNav.fmtDur(Math.max(0, (autoBurn.fireAt - +date) / 1000))}`;
    } else {
      label.textContent = `COASTING  BURN IN ${ExolineNav.fmtDur(Math.max(0, (autoBurn.fireAt - +date) / 1000))}`;
    }
  }
  // Dynamic TWR for the status strip. While landed the throttle term is NOT
  // floored, so a parked craft at 0% throttle reads T/W 0.00 and can flash the
  // low-TWR warning; in flight the floor keeps the readout from flickering to
  // zero during a cutoff.
  function vehicleReadout() {
    if (!F) return;
    $('shipMass').textContent = `${(F.s.m / 1000).toFixed(2)} t`;
    $('shipThrust').textContent = `${(F.thrust / 1000).toFixed(0)} kN`;
    const gravity = 9.80665;
    const throttleTerm = F.s.landed ? F.s.throttle : Math.max(F.s.throttle, .01);
    const twr = F.s.m > 0 ? (F.thrust * throttleTerm) / (F.s.m * gravity) : 0;
    $('shipTwr').textContent = twr.toFixed(2);
    $('shipTwr').classList.toggle('twr-low', F.s.landed === true && twr < 1);
    $('shipStage').textContent = `${Math.min(F.currentStage + 1, F.stages.length)}/${F.stages.length}`;
  }
  // ---------- navigation rendering (world -> screen via the same ws() transform) ----------
  function drawLegPath(records, offset, colour, width, dashed) {
    if (!records || records.length < 2) return;
    const stride = Math.max(1, Math.ceil(records.length / 1800));
    X.save(); X.lineWidth = width; if (dashed) X.setLineDash([6, 5]);
    // v0.1.3 atmosphere tint: vacuum keeps the caller's color; in-air segment
    // midpoints recolor by q at the plan's reference body. Same decimation.
    const refOf = (window.ExolineNav && typeof window.ExolineNav.currentRefId === 'function') ? window.ExolineNav.currentRefId() : null;
    X.strokeStyle = colour; X.beginPath();
    let prev = ws({ x: records[0].r.x + offset.x, y: records[0].r.y + offset.y });
    X.moveTo(prev.x, prev.y);
    for (let i = stride; i < records.length; i += stride) {
      const rec = records[i], p = ws({ x: rec.r.x + offset.x, y: rec.r.y + offset.y });
      const mid = records[Math.max(0, i - (stride >> 1))];
      const tinted = tintForQ(qAtPoint(mid.r, mid.v, refOf)) || colour;
      if (tinted !== X.strokeStyle) { X.stroke(); X.strokeStyle = tinted; X.beginPath(); X.moveTo(prev.x, prev.y); }
      X.lineTo(p.x, p.y); prev = p;
    }
    const last = records[records.length - 1], lp = ws({ x: last.r.x + offset.x, y: last.r.y + offset.y });
    X.lineTo(lp.x, lp.y); X.stroke(); X.restore();
  }
  function localOrbitFromState(state, refId, origin = S[refId]) {
    const physical = P?.bodies?.[refId]; if (!physical || !origin || !state) return null;
    const r = { x: state.r.x - origin.x, y: state.r.y - origin.y }, v = { x: state.v.x - (origin.vx || 0), y: state.v.y - (origin.vy || 0) };
    const R = Math.hypot(r.x, r.y), mu = P.G * physical.mass; if (!(R > 0 && mu > 0)) return null;
    const h = r.x * v.y - r.y * v.x, p = h * h / mu;
    const ev = { x: (((v.x * v.x + v.y * v.y) - mu / R) * r.x - (r.x * v.x + r.y * v.y) * v.x) / mu, y: (((v.x * v.x + v.y * v.y) - mu / R) * r.y - (r.x * v.x + r.y * v.y) * v.y) / mu };
    const e = Math.hypot(ev.x, ev.y), a = p / Math.max(1e-12, 1 - e * e); if (!(e < 1 && a > 0)) return null;
    const ex = e > 1e-6 ? { x: ev.x / e, y: ev.y / e } : { x: r.x / R, y: r.y / R }, perp = { x: -ex.y, y: ex.x };
    return { a, e, ex, perp, period: 2 * Math.PI * Math.sqrt(a ** 3 / mu) };
  }
  function drawPlanetPlan(relRecords, origin, colour, dashed) {
    // Planet-frame planned path: frozen body-relative offsets + LIVE body
    // position. No per-frame math on the live craft state, so zero jitter.
    if (!relRecords || relRecords.length < 2 || !origin) return;
    X.save(); X.lineWidth = 1.8; if (dashed) X.setLineDash([5, 5]);
    // v0.1.3 atmosphere tint over the frozen-relative points: midpoint q is
    // computed against the segment's reference body (carried per record).
    X.strokeStyle = colour; X.beginPath();
    let prev = ws({ x: origin.x + relRecords[0].x, y: origin.y + relRecords[0].y });
    X.moveTo(prev.x, prev.y);
    for (let i = 1; i < relRecords.length; i++) {
      const q = relRecords[i], p = ws({ x: origin.x + q.x, y: origin.y + q.y });
      const mid = relRecords[i - 1];
      const tinted = (mid && mid.refId && mid.r && mid.v ? tintForQ(qAtPoint(mid.r, mid.v, mid.refId)) : null) || colour;
      if (tinted !== X.strokeStyle) { X.stroke(); X.strokeStyle = tinted; X.beginPath(); X.moveTo(prev.x, prev.y); }
      X.lineTo(p.x, p.y); prev = p;
    }
    X.stroke(); X.restore();
  }
  function localNodePosition(seconds, refId) {
    const orbit = localOrbitFromState(F.s, refId), origin = S[refId]; if (!orbit || !origin) return null;
    const r = { x: F.s.r.x - origin.x, y: F.s.r.y - origin.y };
    const nu = Math.atan2(r.x * orbit.perp.x + r.y * orbit.perp.y, r.x * orbit.ex.x + r.y * orbit.ex.y);
    const e0 = 2 * Math.atan2(Math.sqrt(1 - orbit.e) * Math.sin(nu / 2), Math.sqrt(1 + orbit.e) * Math.cos(nu / 2));
    const mean = e0 - orbit.e * Math.sin(e0) + (Math.PI * 2 / orbit.period) * seconds;
    let eccentric = mean;
    for (let i = 0; i < 8; i++) eccentric -= (eccentric - orbit.e * Math.sin(eccentric) - mean) / (1 - orbit.e * Math.cos(eccentric));
    const radial = orbit.a * (1 - orbit.e * Math.cos(eccentric));
    const trueAnomaly = Math.atan2(Math.sqrt(1 - orbit.e * orbit.e) * Math.sin(eccentric), Math.cos(eccentric) - orbit.e);
    return { x: origin.x + radial * (Math.cos(trueAnomaly) * orbit.ex.x + Math.sin(trueAnomaly) * orbit.perp.x), y: origin.y + radial * (Math.cos(trueAnomaly) * orbit.ex.y + Math.sin(trueAnomaly) * orbit.perp.y) };
  }
  function maneuverMarker(mark, offset, localPosition = null) {
    const p = localPosition ? ws(localPosition) : ws({ x: mark.point.x + offset.x, y: mark.point.y + offset.y });
    const selected = mark.node.id === activeNodeId;
    nodeHitRegions.push({ id: mark.node.id, x: p.x, y: p.y, radius: 14 });
    X.save(); X.strokeStyle = selected ? '#fff1f1' : '#ff7373'; X.fillStyle = selected ? '#ff4d4d' : '#c82735'; X.lineWidth = selected ? 2.2 : 1.4;
    X.beginPath(); X.arc(p.x, p.y, selected ? 7 : 5, 0, Math.PI * 2); X.fill(); X.stroke();
    if (selected) { X.strokeStyle = 'rgba(255,115,115,.55)'; X.beginPath(); X.arc(p.x, p.y, 11, 0, Math.PI * 2); X.stroke(); }
    X.fillStyle = '#ffd6d6'; X.font = '9px sans-serif';
    X.fillText(`NODE · T+ ${ExolineNav.fmtDur(mark.node.t)} · ${ExolineNav.fmtDv(mark.node.totalDv)}`, p.x + 10, p.y - 9);
    X.restore();
  }
  function approachMarker(approach, offset) {
    const from = ws(F.s.r), p = ws({ x: approach.point.x + offset.x, y: approach.point.y + offset.y });
    X.save(); X.strokeStyle = 'rgba(255,115,115,.8)'; X.lineWidth = 1.2;
    X.setLineDash([3, 4]); X.beginPath(); X.moveTo(from.x, from.y); X.lineTo(p.x, p.y); X.stroke(); X.setLineDash([]);
    X.beginPath(); X.moveTo(p.x - 4, p.y - 4); X.lineTo(p.x + 4, p.y + 4); X.moveTo(p.x + 4, p.y - 4); X.lineTo(p.x - 4, p.y + 4); X.stroke();
    X.fillStyle = '#ffb3b3'; X.font = '9px sans-serif';
    X.fillText(`MISS ${ExolineNav.fmtDistance(approach.distance)}`, p.x + 7, p.y + 13);
    X.restore();
  }
  function drawFrozenPlannedOrbit(local, liveOrigin) {
    // Frozen post-burn orbit shape (solved once at node edit) drawn around the
    // body's LIVE position: follows the planet, never changes shape.
    if (!local || !liveOrigin) return;
    const b = Math.sqrt(Math.max(0, 1 - local.e * local.e));
    const NW = smoothCount(ellipsePerimeter(local.a, b), 120, 1024);
    const cx = liveOrigin.x - local.a * local.e * local.ex.x;
    const cy = liveOrigin.y - local.a * local.e * local.ex.y;
    X.save(); X.strokeStyle = 'rgba(255,255,255,.96)'; X.lineWidth = 1.5; X.setLineDash([2, 6]); X.beginPath();
    // Offset dash so a dot lands exactly at the maneuver node anomaly
    const nodeOffset = (local.nodeAnomaly || 0) / (2 * Math.PI);
    for (let i = 0; i <= NW; i++) {
      const theta = Math.PI * 2 * i / NW + nodeOffset * 2 * Math.PI;
      const p = ws({ x: cx + local.a * Math.cos(theta) * local.ex.x + local.a * b * Math.sin(theta) * local.perp.x, y: cy + local.a * Math.cos(theta) * local.ex.y + local.a * b * Math.sin(theta) * local.perp.y });
      i ? X.lineTo(p.x, p.y) : X.moveTo(p.x, p.y);
    }
    X.stroke(); X.restore();
  }
  function navPaths() {
    if (!craftSelected || !F || !navSnap || !navSnap.heavy || !navSnap.heavy.base || !navSnap.heavy.base.startR) return;
    const heavy = navSnap.heavy;
    // The local trajectory renderer owns the unburned orbit.  Showing the
    // sampled blue transfer line here makes it read like a sine wave and hides
    // the actual maneuver result.  Only a planned post-burn path is drawn.
    if (!heavy.plan) return;
    // SOI-planet frame only: frozen offsets + live body position. There is no
    // sun-frame rendering anywhere in the flight view.
    const zero = { x: 0, y: 0 };
    const plan = heavy.plan, refId = plan.refId || plan.local?.refId, origin = refId ? S[refId] : null;
    const predictedOrbit = plan.segments[plan.segments.length - 1];
    const isSunPlan = !refId || refId === 'sun';
    if (isSunPlan) {
      if (predictedOrbit) drawLegPath(predictedOrbit.records, zero, '#78e5ff', 1.8, true);
    } else {
      // Draw patched conic segments if available, otherwise fall back to old logic
      if (plan.patchedSegments && plan.patchedSegments.length) {
        // Draw each patched segment in its own reference frame
        for (let si = 0; si < plan.patchedSegments.length; si++) {
          const seg = plan.patchedSegments[si];
          const segRefId = seg.dominantBody || seg.refId || refId;
          const segOrigin = S[segRefId];
          const physical = P.bodies[segRefId];
          if (!segOrigin || !physical) continue;
          const soiRadius = ExolineNav.soiRadius(segRefId);
          // Draw SOI circle for this segment's reference body
          if (soiRadius && finite(soiRadius) && soiRadius > physical.radius_m) {
            const rpx = soiRadius * cam.k;
            if (rpx > 4 && rpx < 3 * Math.max(innerWidth, innerHeight)) {
              X.save(); X.strokeStyle = 'rgba(74,222,128,.28)'; X.lineWidth = 1; X.setLineDash([5, 6]);
              X.beginPath(); X.arc(segOrigin.x, segOrigin.y, rpx, 0, Math.PI * 2); X.stroke(); X.restore();
            }
          }
          // Draw this segment's records
          const segRelRecords = plan.relRecords ? plan.relRecords.filter(r => r.segIndex === si) : [];
          if (seg.impact) {
            drawPlanetPlan(segRelRecords, segOrigin, '#ff7373', true);
            const impactRec = plan.relImpact && plan.relImpact.segIndex === si ? plan.relImpact : null;
            if (impactRec) marker({ x: segOrigin.x + impactRec.x, y: segOrigin.y + impactRec.y }, 'IMPACT', '#ff7373');
          } else if (plan.local && plan.local.refId === segRefId && si === 0) {
            // Only draw the frozen local orbit for the first segment (initial body)
            drawFrozenPlannedOrbit(plan.local, segOrigin);
          } else if (segRelRecords.length >= 2) {
            // Check if this is an escape trajectory (hyperbolic)
            const lastRec = seg.records[seg.records.length - 1];
            if (lastRec) {
              const rRel = { x: lastRec.r.x - segOrigin.x, y: lastRec.r.y - segOrigin.y };
              const vRel = { x: lastRec.v.x - (S[segRefId]?.vx || 0), y: lastRec.v.y - (S[segRefId]?.vy || 0) };
              const R = Math.hypot(rRel.x, rRel.y);
              const mu = P.G * physical.mass;
              const h = rRel.x * vRel.y - rRel.y * vRel.x;
              const V2 = vRel.x * vRel.x + vRel.y * vRel.y;
              const rv = rRel.x * vRel.x + rRel.y * vRel.y;
              const ev = { x: (((V2 - mu / R) * rRel.x - rv * vRel.x) / mu), y: (((V2 - mu / R) * rRel.y - rv * vRel.y) / mu) };
              const e = Math.hypot(ev.x, ev.y);
              const p = h * h / mu;
              if (finite(e) && finite(p) && e > 1 - 1e-6) {
                drawHyperbolicArcPlan(segRefId, rRel, vRel, R, mu, h, e, p, physical, segOrigin, plan);
              } else {
                drawPlanetPlan(segRelRecords, segOrigin, '#ffc96d', true);
                const end = segRelRecords[segRelRecords.length - 1];
                if (end) {
                  X.fillStyle = '#ffcf9c'; X.font = '9px sans-serif';
                  const label = ws({ x: segOrigin.x + end.x, y: segOrigin.y + end.y });
                  X.fillText('ESCAPE', label.x + 7, label.y - 7);
                }
              }
            } else {
              drawPlanetPlan(segRelRecords, segOrigin, '#ffc96d', true);
            }
          }
          // Draw SOI exit marker if this segment crosses into another body's SOI
          if (seg.soiCrossing) {
            const cross = seg.soiCrossing;
            const crossRec = seg.records.find(r => Math.abs(r.t - cross.crossTime) < 1);
            if (crossRec) {
              const crossPos = ws({ x: crossRec.r.x, y: crossRec.r.y });
              X.fillStyle = '#ffcf9c'; X.font = '9px sans-serif';
              X.fillText(`SOI → ${cross.toBody.toUpperCase()}`, crossPos.x + 7, crossPos.y - 7);
            }
          }
        }
      } else if (origin && plan.relRecords) {
        // Legacy single-body fallback
        const physical = P.bodies[refId];
        const soiRadius = physical ? ExolineNav.soiRadius(refId) : null;
        if (soiRadius && finite(soiRadius) && soiRadius > physical.radius_m) {
          const rpx = soiRadius * cam.k;
          if (rpx > 4 && rpx < 3 * Math.max(innerWidth, innerHeight)) {
            X.save(); X.strokeStyle = 'rgba(74,222,128,.28)'; X.lineWidth = 1; X.setLineDash([5, 6]);
            X.beginPath(); X.arc(origin.x, origin.y, rpx, 0, Math.PI * 2); X.stroke(); X.restore();
          }
        }
        if (plan.impact) {
          drawPlanetPlan(plan.relRecords, origin, '#ff7373', true);
          if (plan.relImpact) marker({ x: origin.x + plan.relImpact.x, y: origin.y + plan.relImpact.y }, 'IMPACT', '#ff7373');
        } else if (plan.local && plan.local.refId === refId) {
          drawFrozenPlannedOrbit(plan.local, origin);
        } else if (plan.relRecords && plan.relRecords.length >= 2) {
          const lastSeg = plan.segments[plan.segments.length - 1];
          const endState = lastSeg.endState;
          const rRel = { x: endState.r.x - origin.x, y: endState.r.y - origin.y };
          const vRel = { x: endState.v.x - (S[refId]?.vx || 0), y: endState.v.y - (S[refId]?.vy || 0) };
          const R = Math.hypot(rRel.x, rRel.y);
          const mu = P.G * physical.mass;
          const h = rRel.x * vRel.y - rRel.y * vRel.x;
          const V2 = vRel.x * vRel.x + vRel.y * vRel.y;
          const energy = V2 / 2 - mu / R;
          const rv = rRel.x * vRel.x + rRel.y * vRel.y;
          const ev = { x: (((V2 - mu / R) * rRel.x - rv * vRel.x) / mu), y: (((V2 - mu / R) * rRel.y - rv * vRel.y) / mu) };
          const e = Math.hypot(ev.x, ev.y);
          const p = h * h / mu;
          if (finite(e) && finite(p) && e > 1 - 1e-6) {
            drawHyperbolicArcPlan(refId, rRel, vRel, R, mu, h, e, p, physical, origin, plan);
          } else {
            drawPlanetPlan(plan.relRecords, origin, '#ffc96d', true);
            const end = plan.relRecords[plan.relRecords.length - 1];
            X.fillStyle = '#ffcf9c'; X.font = '9px sans-serif';
            const label = ws({ x: origin.x + end.x, y: origin.y + end.y });
            X.fillText('ESCAPE', label.x + 7, label.y - 7);
          }
        }
        if (plan.relApproach && !plan.impact) approachMarker({ point: { x: origin.x + plan.relApproach.x, y: origin.y + plan.relApproach.y }, distance: plan.approach ? plan.approach.distance : 0 }, zero);
        else if (plan.approach && plan.approach.point && !plan.approach.atHorizon) approachMarker(plan.approach, zero);
      }
    }
    const liveTimes = new Map((navSnap.nodes || []).map(n => [n.id, n.t]));
    for (const mark of heavy.plan.marks) {
      if (liveTimes.has(mark.node.id)) mark.node.t = liveTimes.get(mark.node.id);
      const markOrigin = (mark.refId && S[mark.refId]) || (plan.refId && S[plan.refId]) || null;
      const markPos = (mark.rel && markOrigin) ? { x: markOrigin.x + mark.rel.x, y: markOrigin.y + mark.rel.y } : (mark.point || null);
      maneuverMarker(mark, zero, markPos);
    }
  }
  function drawTargetMarker() {
    if (!navSnap || !navSnap.targetId) return;
    const state = S[navSnap.targetId]; if (!state) return;
    const p = ws(state); // canonical COM: same world->screen transform as sprite, orbit, selection
    const catalog = D.bodies.find(b => b.id === navSnap.targetId);
    const screenR = catalog ? radiusOf(catalog) : 4;
    const R = Math.max(13, screenR > 10 ? screenR * 1.35 + 7 : 13);
    if (navSnap.targetSoiRadius) {
      const soiPx = navSnap.targetSoiRadius * cam.k;
      if (soiPx > 20 && soiPx < 9000) { X.save(); X.strokeStyle = 'rgba(109,184,255,.28)'; X.lineWidth = 1; X.setLineDash([5, 6]); X.beginPath(); X.arc(p.x, p.y, soiPx, 0, Math.PI * 2); X.stroke(); X.restore(); }
    }
    const arm = Math.min(7, R * .5);
    X.save(); X.strokeStyle = '#6db8ff'; X.lineWidth = 1.6;
    for (const corner of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const sx = corner[0], sy = corner[1], cx = p.x + sx * R, cy = p.y + sy * R;
      X.beginPath(); X.moveTo(cx - sx * arm, cy); X.lineTo(cx, cy); X.lineTo(cx, cy - sy * arm); X.stroke();
    }
    X.fillStyle = '#eaf7ff'; X.font = '8px sans-serif';
    X.fillText(`TARGET · ${navSnap.targetName.toUpperCase()}`, p.x - R, p.y + R + 11);
    X.restore();
  }
  function navArrow(origin, dir, colour, kind) {
    const planar = Math.hypot(dir.x, dir.y);
    if (planar < .18) return; // direction mostly out of plane: no misleading 2D arrow (PART 11)
    const dx = dir.x * cam.k, dy = -dir.y * cam.k, mag = Math.hypot(dx, dy);
    if (!(mag > 0)) return;
    const ux = dx / mag, uy = dy / mag, px = -uy, py = ux;
    const x0 = origin.x + ux * 11, y0 = origin.y + uy * 11, x1 = origin.x + ux * 30, y1 = origin.y + uy * 30;
    X.save(); X.globalAlpha = Math.min(1, planar * 1.5); X.strokeStyle = colour; X.fillStyle = colour; X.lineWidth = 1.3;
    if (kind === 'retro') X.setLineDash([3, 3]);
    X.beginPath(); X.moveTo(x0, y0); X.lineTo(x1, y1); X.stroke(); X.setLineDash([]);
    if (kind === 'pro') { X.beginPath(); X.moveTo(x1 + ux * 6, y1 + uy * 6); X.lineTo(x1 + px * 4, y1 + py * 4); X.lineTo(x1 - px * 4, y1 - py * 4); X.closePath(); X.stroke(); }
    else if (kind === 'retro') { X.beginPath(); X.arc(x1, y1, 4, 0, Math.PI * 2); X.stroke(); X.beginPath(); X.moveTo(x1 - px * 4, y1 - py * 4); X.lineTo(x1 + px * 4, y1 + py * 4); X.stroke(); }
    else { X.beginPath(); X.moveTo(x1 - ux * 5 + px * 4, y1 - uy * 5 + py * 4); X.lineTo(x1 + ux * 2, y1 + uy * 2); X.lineTo(x1 - ux * 5 - px * 4, y1 - uy * 5 - py * 4); X.stroke(); }
    X.restore();
  }
  function drawVectors() {
    if (!craftSelected || !F || !navSnap) return;
    const origin = ws(F.s.r);
    const frame = ExolineNav.getVelocityFrame(F.s, navSnap.refId, 0);
    if (frame) {
      navArrow(origin, frame.prograde, '#77edff', 'pro');
      navArrow(origin, { x: -frame.prograde.x, y: -frame.prograde.y, z: -frame.prograde.z }, '#ffbd76', 'retro');
      const planning = !$('navNode').classList.contains('hidden');
      if (planning) {
        navArrow(origin, frame.radial, 'rgba(234,247,255,.85)', 'radial');
        navArrow(origin, { x: -frame.radial.x, y: -frame.radial.y, z: -frame.radial.z }, 'rgba(234,247,255,.5)', 'radial');
      }
    }
  }
  // ---------- navigation panel (DOM updates, never math) ----------
  function navUi() {
    const snap = navSnap; if (!snap) return;
    const show = craftSelected || snap.targetId || snap.nodes.length;
    $('navPanel').classList.toggle('hidden', !show);
    if (!show) return;
    const els = snap.elements;
    setText('navSoi', snap.refName.toUpperCase());
    setText('navTarget', snap.targetName ? snap.targetName.toUpperCase() : '—');
    setText('navDist', snap.live ? ExolineNav.fmtDistance(snap.live.distance) : '—');
    setText('navRelVel', snap.live ? ExolineNav.fmtSpeed(snap.live.speedRel) : '—');
    setText('navApo', ExolineNav.fmtApo(els));
    setText('navPeri', ExolineNav.fmtPeri(els));
    setText('navEcc', els ? ExolineNav.fmtEcc(els.ecc) : '—');
    setText('navSpeed', els ? ExolineNav.fmtSpeed(els.speed) : '—');
    setText('navRadial', els ? ExolineNav.fmtSignedSpeed(els.radial) : '—');
    setText('navClosing', snap.live ? ExolineNav.fmtSignedSpeed(snap.live.closing) : '—');
    setText('navTca', snap.approach && !snap.approach.atHorizon ? ExolineNav.fmtDur(snap.approach.tSec) : '—');
    setText('navMiss', snap.approach ? ExolineNav.fmtDistance(snap.approach.distance) : '—');
    setText('navPeriod', els && els.period ? ExolineNav.fmtDur(els.period) : '—');
    setText('navVEsc', els ? ExolineNav.fmtSpeed(els.vEsc) : '—');
    setText('navEnergy', ExolineNav.fmtEnergy(els ? els.energy : null));
    setText('navInc', els ? ExolineNav.fmtDeg(els.inc) : '—');
    const transfer = snap.transfer;
    setText('navTransferTitle', transfer ? `${transfer.method} · APPROX` : '—');
    setText('navTransferDep', transfer ? ExolineNav.fmtDv(transfer.dvDeparture) : '—');
    setText('navTransferArr', transfer ? ExolineNav.fmtDv(transfer.dvArrival) : '—');
    setText('navTransferTime', transfer ? ExolineNav.fmtDur(transfer.timeSeconds) : '—');
    setText('navDvTotal', snap.nodes.length ? ExolineNav.fmtDv(snap.dvTotal) : '—');
    if (sel) setText('setTargetBtn', snap.targetId === sel.id ? 'TARGETED ✓' : 'SET TARGET');
    else setText('setTargetBtn', 'SET TARGET');
    syncNodeForm(snap);
  }
  function syncNodeForm(snap) {
    const node = snap.nodes.find(n => n.id === activeNodeId) || snap.nodes[0];
    if (!node) { activeNodeId = null; $('navNode').classList.add('hidden'); return; }
    activeNodeId = node.id;
    setText('navNodeTime', `T+ ${ExolineNav.fmtDur(node.t)}`);
    setText('navNodeTotal', ExolineNav.fmtDv(node.totalDv));
    const fields = [['navNodePro', 'progradeDv'], ['navNodeRad', 'radialDv'], ['navNodeNor', 'normalDv']];
    for (const field of fields) { const input = $(field[0]); if (document.activeElement !== input && String(node[field[1]]) !== input.value) input.value = String(node[field[1]]); }
  }
  function addNodeForCraft(time = 600) {
    const node = ExolineNav.addNode({ t: Math.max(0, time), referenceBody: ExolineNav.currentRefId() });
    const refId = node.referenceBody, point = refId !== 'sun' ? localNodePosition(node.t, refId) : null;
    if (point && S[refId]) nodeAnchors.set(node.id, { refId, rel: { x: point.x - S[refId].x, y: point.y - S[refId].y } });
    activeNodeId = node.id;
    $('navNode').classList.remove('hidden');
    $('navPanel').classList.remove('hidden');
    $('navPanel').classList.remove('collapsed');
    showToast(`MANEUVER NODE ADDED · T+ ${ExolineNav.fmtDur(Math.max(0, time))}`);
  }
  function stepNodeTime(direction) {
    const nodes = ExolineNav.getNodes(), node = nodes.find(n => n.id === activeNodeId) || nodes[0];
    if (!node) return;
    // Epoch-based: derive live remaining from the absolute burn epoch (drift-free).
    const remaining = Math.max(0, ((node.epoch || (+date + (node.t || 0) * 1000)) - +date) / 1000);
    const step = remaining >= 86400 ? 3600 : remaining >= 3600 ? 300 : 60;
    ExolineNav.updateNode(node.id, { t: Math.max(0, remaining + direction * step) });
    ExolineNav.setEditing(true);
    setTimeout(() => ExolineNav.setEditing(false), 500);
  }
  const angleDelta = (from, to) => Math.atan2(Math.sin(to - from), Math.cos(to - from));
  function startAutoBurn() {
    const node = ExolineNav.getNodes().find(n => n.id === activeNodeId) || ExolineNav.getNodes()[0];
    if (!node) { showToast('AUTO BURN · NO NODE'); return; }
    if (Math.abs(node.normalDv) > .01) { showToast('AUTO BURN · NORMAL Δv NEEDS 3D RCS'); return; }
    if (node.totalDv <= .01) { showToast('AUTO BURN · SET A Δv FIRST'); return; }
    const needed = F.propellantForDeltaV(node.totalDv);
    if (!F.infiniteFuel && needed > F.s.propellant + 1e-6) { showToast(`AUTO BURN · NEEDS ${Math.ceil(needed)} kg FUEL`); return; }
    // Panel must be open: collapsed nav-body is display:none, which would hide
    // the burn progress bar entirely for the whole maneuver.
    $('navPanel').classList.remove('hidden', 'collapsed');
    $('navNode').classList.remove('hidden');
    // Center the finite burn on the node epoch (KSP style): start half a burn
    // early so the impulsive prediction stays accurate.
    const mdot = F.thrust / (F.specificImpulse * 9.80665);
    const burnTime = mdot > 0 ? needed / mdot : 0;
    const epoch = node.epoch || (+date + node.t * 1000);
    autoBurn = { nodeId: node.id, nodeTime: node.t, fireAt: epoch - burnTime * 0.5, delivered: 0, phase: 'COAST', initialMass: 0, estBurn: burnTime, burnSimStart: 0, appliedRate: 0, alignWindow: Math.max(90, Math.min(900, burnTime * 4)) };
    // Cut the engine for the coast-to-node phase. Without this a throttle left
    // on before arming keeps firing (prograde-locked) all the way to the node,
    // which silently destroys the planned burn vector and looks like the craft
    // "accelerating on its own". The burn window re-commands the throttle.
    setThrottle(0, true);
    $('throttle').disabled = true; $('launchBtn').disabled = true;
    // Warp is KEPT while coasting to the node (so you can time-warp toward the
    // burn instead of idling at 1x). It drops to 1x only when the align window
    // opens, because a multi-second burn cannot be resolved at high warp.
    $('navExecute').textContent = 'CANCEL AUTO';
    showToast(`AUTO BURN ARMED · T+ ${ExolineNav.fmtDur(node.t)}`);
  }
  function cancelAutoBurn(message = 'AUTO BURN CANCELLED') {
    autoBurn = null; setThrottle(0, true); $('throttle').disabled = false; $('launchBtn').disabled = false; $('navExecute').textContent = 'AUTO BURN'; showToast(message);
  }
  function updateAutoBurn(physicsSeconds) {
    if (!autoBurn) return;
    const node = ExolineNav.getNodes().find(n => n.id === autoBurn.nodeId);
    if (!node || F.s.crashed || (!F.infiniteFuel && F.s.propellant <= 0)) { cancelAutoBurn('AUTO BURN ABORTED'); return; }
    // Enter the align window a few burn-times before fireAt and drop to 1x —
    // a multi-second burn cannot be resolved at high warp.
    if (autoBurn.phase === 'COAST' && +date >= autoBurn.fireAt - (autoBurn.alignWindow || 15000)) { autoBurn.phase = 'ALIGN'; if (warpIndex !== 0) setWarp(0); }
    if (autoBurn.phase !== 'ALIGN' && autoBurn.phase !== 'BURN') return;
    // No forced 1x here: warp is only dropped when entering ALIGN above.
    const burn = ExolineNav.calculateBurn(node);
    if (!burn || burn.total <= 0) { cancelAutoBurn('AUTO BURN · BAD Δv'); return; }
    // Steer along the craft's LIVE local frame: the burn fires while the craft
    // is sitting AT the node (inside the align window), so the live
    // prograde/radial basis is exact. The frozen/predicted vector is only
    // trustworthy when the pre-node coast was solved over its full length, but
    // the step-budgeted preview cannot reach a node days away — its frame mixes
    // epochs (craft state clipped to the step budget, reference body sampled at
    // the true node epoch), which points the burn the wrong way and decays the
    // craft into the planet instead of transferring to the target.
    const frame = ExolineNav.getVelocityFrame(F.s, node.referenceBody, 0);
    if (!frame) { cancelAutoBurn('AUTO BURN · BAD FRAME'); return; }
    const dv = {
      x: frame.prograde.x * burn.prograde + frame.radial.x * burn.radial,
      y: frame.prograde.y * burn.prograde + frame.radial.y * burn.radial
    };
    if (Math.hypot(dv.x, dv.y) < 1e-9) { cancelAutoBurn('AUTO BURN · BAD Δv'); return; }
    // Rate-limited slew that can NEVER overshoot: the applied rotation is
    // clamped to the remaining angle itself, so the heading error is
    // monotonically non-increasing at every time step. (The previous
    // proportional form multiplied the error by -3 per call and diverged at
    // high warp, which spun the craft and broke the burn.)
    const targetHeading = Math.atan2(dv.y, dv.x);
    const error = angleDelta(F.s.heading, targetHeading);
    const maxRate = 2.5 * Math.max(0, physicsSeconds);
    F.s.heading += Math.abs(error) < 1e-9 ? 0 : Math.sign(error) * Math.min(Math.abs(error), maxRate);
    // Watchdog: sim-time cap so a burn can never run forever.
    if (autoBurn.phase === 'BURN') {
      if (!autoBurn.burnSimStart) autoBurn.burnSimStart = +date;
      if ((+date - autoBurn.burnSimStart) / 1000 > (autoBurn.estBurn || 60) * 3 + 120) { cancelAutoBurn('AUTO BURN TIMEOUT'); return; }
    }
    if (Math.abs(error) > .035 || +date < autoBurn.fireAt) { autoBurn.appliedRate = 0; setThrottle(0, true); return; }
    autoBurn.phase = 'BURN';
    if (!autoBurn.burnSimStart) autoBurn.burnSimStart = +date;
    // Throttle control: full thrust when far, then taper so the Δv lands
    // exactly at the planned value within one chunk. The taper is scaled by
    // the chunk length, so a large warp step cannot overshoot the burn.
    const remaining = Math.max(0, node.totalDv - (autoBurn.delivered || 0));
    const accel = F.thrust / Math.max(F.s.m, 1);
    let thr;
    if (Math.abs(error) > .12) thr = 0;
    else {
      const burnSeconds = remaining / Math.max(accel, 1e-9);
      thr = burnSeconds >= physicsSeconds ? 100 : Math.max(5, Math.min(100, burnSeconds / Math.max(physicsSeconds, 1e-9) * 100));
    }
    autoBurn.appliedRate = F.thrust * (thr / 100) / Math.max(F.s.m, 1);
    setThrottle(thr, true);
  }
  function finishAutoBurn(physicsSeconds) {
    if (!autoBurn || autoBurn.phase !== 'BURN') return;
    const node = ExolineNav.getNodes().find(n => n.id === autoBurn.nodeId);
    if (!node) return;
    // Delivered Δv = integrated thrust acceleration. Exact in every fuel mode
    // (infinite fuel never changes mass, so mass-ratio tracking can't work).
    const rate = autoBurn.appliedRate || 0;
    if (rate > 0 && physicsSeconds > 0) autoBurn.delivered = (autoBurn.delivered || 0) + rate * physicsSeconds;
    autoBurn.appliedRate = 0;
    // Tight commit tolerance: the burn must land ON the planned Δv. An escape-
    // class transfer (e.g. TLI) is hypersensitive near the parabolic energy, so
    // even a ~1% early cutoff (tens of m/s) throws the apoapsis ~100,000 km
    // short of the target and the craft never reaches it.
    // Near-parabolic transfers magnify a Δv error by ~3,700 km per m/s, so the
    // commit tolerance has to be a small fraction of a m/s: the old 2%-of-chunk
    // window let the burn stop ~1.1 m/s early, which is ~4,000 km of apogee and
    // tens of thousands of km of encounter error.
    const tol = Math.max(0.01, rate * physicsSeconds * 0.002);
    if (autoBurn.delivered + tol < node.totalDv) return;
    const id = autoBurn.nodeId;
    setThrottle(0, true); nodeAnchors.delete(id); ExolineNav.commitExecution(id); ExolineNav.invalidate();
    autoBurn = null; $('throttle').disabled = false; $('launchBtn').disabled = false; $('navExecute').textContent = 'AUTO BURN';
    if (!ExolineNav.getNodes().length) $('navNode').classList.add('hidden');
    showToast(`AUTO BURN COMPLETE · Δv ${ExolineNav.fmtDv(node.totalDv)}`);
    // Chain the maneuver sequence. A transfer is a DEPARTURE plus a CAPTURE —
    // two nodes — but only the node that was armed ever fired, so the capture
    // burn never executed and the craft sailed straight past the Moon, which
    // reads as "bouncing off" its sphere of influence. Hand off to the next
    // remaining node so the whole plan runs to completion on its own.
    const next = ExolineNav.getNodes().slice().sort((a, b) => (a.epoch || 0) - (b.epoch || 0)).find(n => n.totalDv > .01);
    if (next) {
      activeNodeId = next.id;
      $('navNode').classList.remove('hidden');
      $('navPanel').classList.remove('hidden', 'collapsed');
      setTimeout(() => startAutoBurn(), 0);
    }
  }
  function updateWarp() { const button = $('warpBtn'); button.innerHTML = `${running ? pauseIcon : playIcon}<span>${running ? warpText(WARP[warpIndex]) : ''}</span>`; button.classList.toggle('is-paused', !running); button.setAttribute('aria-label', running ? `Pause at ${warpText(WARP[warpIndex])}` : 'Resume simulation'); }
  function setWarp(index) { warpIndex = Math.max(0, Math.min(WARP.length - 1, index)); simulationBacklog = 0; updateWarp(); }
  function follow() {
    // Dragging or a held manual pan always wins over auto-follow.
    if (panning || panned) return;
    if (craftSelected && F) {
      cam.o.x = F.s.r.x;
      cam.o.y = F.s.r.y;
    } else if (currentSoi) {
      cam.o.x = S[currentSoi.id].x;
      cam.o.y = S[currentSoi.id].y;
    }
  }
  function focusCraftView() {
    if (!F) return;
    cam.o = { x: F.s.r.x, y: F.s.r.y };
    cam.k = zoomCraft();
  }
  function zoomCraft() {
    if (!F) return 0;
    const diag = F.diagnostics(S, sel?.id);
    const bodyId = diag.body;
    const physical = P?.bodies?.[bodyId];
    if (!physical || !finite(diag.a) || diag.a <= 0) return 70 / 6.4e6;
    // Fit the craft's current conic (semi-major axis / apoapsis) to a readable
    // screen size so the orbit ring is always visible and the body is never a
    // microscopic dot.
    const target = finite(diag.apo) && diag.apo > diag.a ? diag.apo : diag.a;
    return 340 / target;
  }
  function resetView() {
    cam.k = innerHeight / (2.5 * AU);
    cam.o.x = 0;
    cam.o.y = 0;
  }
  function draw() {
    const soi = soiBody();
    if (soi) currentSoi = soi;
    else currentSoi = null;
    // v0.2.0: edge-triggered surface capture runs before anything draws.
    try { surfTrackTransitions(); } catch { /* surface bookkeeping never breaks orbit view */ }
    if (viewMode === 'surface') {
      // Surface mode: orbit canvas draw skipped entirely; nav tick and
      // physics keep running normally (frame() is untouched). The tile
      // renderer owns #mapCanvas; only HUD panels update here.
      // v0.2.0 FIX: MapRenderer has no internal loop — redraw event-driven
      // only — so without a per-frame draw() here the surface canvas freezes
      // on its entry paint (tiles never stream in, markers/glide stall).
      // draw() is token-guarded: overlapping async calls abort safely, and
      // image loads are promise-cached, so this is cheap once tiles settle.
      try { if (mapRenderer && mapRenderer.surf) mapRenderer.draw(); } catch { /* surface canvas never breaks HUD */ }
      try {
        navSnap = ExolineNav.tick();
      } catch (error) {
        console.error('Navigation preview unavailable:', error);
        navSnap = null;
      }
      hud();
      surfaceHud();
      navUi();
      vehicleReadout();
      $('simDate').textContent = date.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
      updateWarp();
      if (window.ExolinePhysicsAgent && window.ExolinePhysicsAgent.drawDebugOverlay) {
        window.ExolinePhysicsAgent.drawDebugOverlay(X);
      }
      return;
    }
    follow();
    // Continuous keyboard pan (held keys) -- independent of the mouse drag.
    const panSpeed = 5 / (cam.k || 1);
    if (keys.pan.up) cam.o.y -= panSpeed;
    if (keys.pan.down) cam.o.y += panSpeed;
    if (keys.pan.left) cam.o.x += panSpeed;
    if (keys.pan.right) cam.o.x -= panSpeed;
    try {
      navSnap = ExolineNav.tick();
    } catch (error) {
      // Navigation preview must never prevent the flight scene or mission menu
      // from opening. The next invalidation can rebuild it after bad input.
      console.error('Navigation preview unavailable:', error);
      navSnap = null;
    }
    nodeHitRegions = []; orbitHitRegions = [];
    X.fillStyle = '#02070c';
    X.fillRect(0, 0, innerWidth, innerHeight);
    for (let i = 0; i < 140; i++) { X.fillStyle = 'rgba(190,230,250,.25)'; X.fillRect((i * 197) % innerWidth, (i * 89) % innerHeight, 1, 1); }
    if (!D) return;
    drawSoiCircles();
    D.bodies.forEach(b => orbit(b.id));
    body({ id: 'sun', name: 'Sun', orbital_asset: D.sun.asset }, S.sun);
    D.bodies.forEach(b => body(b, S[b.id]));
    try { drawSiteTicks(); } catch { /* site ticks never break orbit view */ }
    trajectory();
    navPaths();
    impactMarker();
    drawTargetMarker();
    craft();
    drawVectors();
    hud();
    try { if (viewMode === 'orbit') surfaceHud(); } catch { /* surface HUD never breaks orbit view */ }
    navUi();
    vehicleReadout();
    $('simDate').textContent = date.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
    updateWarp();
    if (window.ExolinePhysicsAgent && window.ExolinePhysicsAgent.drawDebugOverlay) {
      window.ExolinePhysicsAgent.drawDebugOverlay(X);
    }
  }
  function inspect(body) { sel = body; craftSelected = false; lock = 'body'; $('detailPanel').classList.remove('hidden'); $('detailName').textContent = body.name; $('detailKicker').textContent = 'CELESTIAL BODY'; $('detailSub').textContent = body.parent ? `MOON OF ${body.parent.toUpperCase()}` : 'SOL SYSTEM'; $('detailType').textContent = body.type; $('detailOrbit').textContent = body.kind === 'major_moon' ? 'LOCAL ORBIT' : 'HELIOCENTRIC'; $('detailPeriod').textContent = 'LIVE STATE'; $('detailSeed').textContent = body.seed || '—'; $('detailNote').textContent = 'Orbital position and rendered orbit use the same propagated Keplerian state.'; if (minerals) { const data = minerals[body.name]; const box = $('minerals'); if (!data) { box.textContent = 'No mineral profile defined for this body.'; return; } box.textContent = ''; for (const [name, frac] of Object.entries(data).sort((a, b) => b[1] - a[1])) { const row = document.createElement('div'); row.className = 'mineral-row'; const pct = (frac * 100).toFixed(1); row.innerHTML = `<span class="name">${name}</span><span class="value">${pct}%</span><div class="mineral-bar"><i style="width:${pct}%"></i></div>`; box.appendChild(row); } } cam.o = { x: S[body.id].x, y: S[body.id].y }; cam.k = Math.max(cam.k, 24 / P.bodies[body.id].radius_m); }
  function pick(x, y) { let chosen, best = Infinity; for (const body of D.bodies) { const p = ws(S[body.id]), anchor = A[body.id] || A.default || {}, r = Math.max(9, radiusOf(body) * (anchor.disk_scale || .848)), score = Math.hypot(p.x - x, p.y - y) / r; if (score <= 1 && score < best) { chosen = body; best = score; } } return chosen; }
  async function openMap() { if (!sel) return; if (viewMode === 'surface') exitSurface(false); terrain ??= await (await fetch('../data/terrain_manifest.json')).json(); const manifest = terrain.bodies[sel.id]; if (!manifest) return; C.style.display = 'none'; $('mapCanvas').classList.remove('hidden'); $('mapCanvas').style.display = 'block'; $('mapTopbar').classList.remove('hidden'); if (!mapRenderer) mapRenderer = new ExolineMap.MapRenderer($('mapCanvas'), { terrainManifest: manifest, onZoom: zoom => { $('mapReadout').textContent = `MAP · ${zoom.toFixed(1)}×`; } }); await mapRenderer.open(sel, manifest); }
  function closeMission() { $('missionScreen').classList.add('hidden'); $('app').classList.remove('mission-active'); }
  function renderChangelog(markdown) { const target = $('changelogContent'); target.replaceChildren(); let list; for (const line of markdown.split(/\r?\n/)) { if (line.startsWith('### ')) { list = null; const heading = document.createElement('h2'); heading.textContent = line.slice(4); target.append(heading); } else if (line.startsWith('- ')) { if (!list) { list = document.createElement('ul'); target.append(list); } const item = document.createElement('li'); item.textContent = line.slice(2); list.append(item); } else if (line.trim()) { list = null; const paragraph = document.createElement('p'); paragraph.textContent = line.replace(/^# /, ''); target.append(paragraph); } else list = null; } }
  // Launch-site presets that are not physical bodies, listed after them in the
  // mission screen's launch-site dropdown. Both start inserted in a 400 km
  // circular orbit instead of parked on a pad:
  //   LEO = low Earth orbit · LOI = Lunar Orbit Insertion (around the Moon).
  const ORBITAL_LAUNCH_SITES = {
    leo: { body: 'earth', altitude: 400000, label: 'LEO' },
    loi: { body: 'earth:moon', altitude: 400000, label: 'LOI' }
  };
  const launchSite = site => {
    const preset = ORBITAL_LAUNCH_SITES[site];
    if (preset) F.launchOrbit(preset.body, S, preset.altitude);
    else F.launch(site, S);
  };
  function controls() {
    $('exploreSolBtn').onclick = closeMission; $('continueMissionBtn').onclick = closeMission;
    // ENTER sits directly under the initial-orbit selector, so it must honour
    // it: if the chosen body differs from the current one, launch there; if it
    // matches, just resume. (Previously ENTER only closed the menu, so the
    // selector appeared to do nothing.)
    const selectedOrbitId = () => { const v = $('orbitSelect') && $('orbitSelect').value; return v && (P.bodies[v] || ORBITAL_LAUNCH_SITES[v]) ? v : null; };
    const applySelectedOrbit = () => {
      const id = selectedOrbitId();
      if (id && id !== (F.circularHold?.id || ExolineNav.currentRefId())) {
        launchSite(id); nodeAnchors.clear(); ExolineNav.onReset(); ExolineNav.invalidate(); cam.o = { x: F.s.r.x, y: F.s.r.y };
      }
      closeMission();
    };
    $('missionEnter').onclick = applySelectedOrbit;
    // Populate orbit selector with all bodies from physics_constants
    function populateOrbitSelect() {
      const select = $('orbitSelect');
      select.innerHTML = '';
      // Every body in physics_constants.json, so a launch can begin at any
      // world (launch site later).
      const ids = Object.keys(P.bodies).sort((a, b) => ExolineNav.bodyName(a).localeCompare(ExolineNav.bodyName(b)));
      for (const id of ids) {
        const opt = document.createElement('option');
        opt.value = id;
        opt.textContent = ExolineNav.bodyName(id);
        select.appendChild(opt);
      }
      // Non-body presets (LOI …) follow the physical launch sites.
      for (const [key, preset] of Object.entries(ORBITAL_LAUNCH_SITES)) {
        const opt = document.createElement('option');
        opt.value = key;
        opt.textContent = preset.label;
        select.appendChild(opt);
      }
      // Restore saved selection, defaulting to Earth.
      const saved = localStorage.getItem('exoline.orbitSelect');
      select.value = saved && (P.bodies[saved] || ORBITAL_LAUNCH_SITES[saved]) ? saved : 'earth';
      select.onchange = () => localStorage.setItem('exoline.orbitSelect', select.value);
    }
    $('newCampaignBtn').onclick = () => { const selId = selectedOrbitId() || 'earth'; launchSite(selId); nodeAnchors.clear(); ExolineNav.onReset(); ExolineNav.invalidate(); cam.o = { x: F.s.r.x, y: F.s.r.y }; closeMission(); };
    // Populate orbit selector on mission screen open
    populateOrbitSelect();
    $('orbitSelect').onchange = () => localStorage.setItem('exoline.orbitSelect', $('orbitSelect').value);
    $('changelogBtn').onclick = async () => { $('changelogPanel').classList.remove('hidden'); try { renderChangelog(await (await fetch('../version_change.md', { cache: 'no-store' })).text()); } catch { $('changelogContent').textContent = 'Unable to load version_change.md'; } }; $('closeChangelog').onclick = () => $('changelogPanel').classList.add('hidden');
    const renderKeybinds = () => document.querySelectorAll('[data-bind]').forEach(input => { input.value = bindingLabel(bindings[input.dataset.bind]); });
    const saveBindings = () => localStorage.setItem('exoline.keybinds', JSON.stringify(bindings));
    $('settingsBtn').onclick = () => { renderKeybinds(); $('settingsPanel').classList.remove('hidden'); }; $('closeSettings').onclick = () => $('settingsPanel').classList.add('hidden');
    $('infiniteFuel').onchange = e => { F.infiniteFuel = e.target.checked; showToast(F.infiniteFuel ? 'INFINITE FUEL ENABLED' : 'INFINITE FUEL DISABLED'); };
    const progradeBox = $('progradeLock');
    if (progradeBox) { F.progradeLock = progradeBox.checked !== false; progradeBox.onchange = e => { F.progradeLock = e.target.checked; showToast(F.progradeLock ? 'PROGRADE LOCK ENABLED' : 'PROGRADE LOCK DISABLED'); }; }
    document.querySelectorAll('[data-bind]').forEach(input => {
      input.onclick = () => { input.value = 'PRESS KEY'; input.focus(); };
      input.onkeydown = event => {
        event.preventDefault(); event.stopPropagation();
        const action = input.dataset.bind, duplicate = Object.entries(bindings).find(([name, code]) => name !== action && code === event.code);
        if (duplicate) { showToast(`${bindingLabel(event.code)} ALREADY USED`); renderKeybinds(); return; }
        bindings[action] = event.code; saveBindings(); renderKeybinds(); showToast(`${action.replace(/([A-Z])/g, ' $1').toUpperCase()} · ${bindingLabel(event.code)}`);
      };
    });
    $('resetKeybinds').onclick = () => { bindings = { ...defaultBindings }; saveBindings(); renderKeybinds(); showToast('KEYBINDS RESET'); };
    $('slower').innerHTML = rewindIcon; $('faster').innerHTML = forwardIcon; $('slower').onclick = e => { e.preventDefault(); e.stopPropagation(); setWarp(warpIndex - 1); }; $('faster').onclick = e => { e.preventDefault(); e.stopPropagation(); setWarp(warpIndex + 1); }; $('warpBtn').onclick = e => { e.preventDefault(); e.stopPropagation(); running = !running; updateWarp(); };
    $('throttle').oninput = e => setThrottle(e.target.value); $('turnLeft').onpointerdown = () => keys.right = true; $('turnRight').onpointerdown = () => keys.left = true; addEventListener('pointerup', () => { keys.left = false; keys.right = false; });
    $('launchBtn').onclick = () => { if (autoBurn) { showToast('THROTTLE CONTROLLED BY AUTO BURN'); return; } if (F && F.descentMode) { showToast('THROTTLE CONTROLLED BY DESCENT'); return; } craftSelected = true; lock = 'craft'; sel = null; focusCraftView(); setThrottle(F.s.throttle > 0 ? 0 : 100); $('launchBtn').textContent = F.s.throttle ? 'CUTOFF' : 'IGNITION'; }; $('rcsBtn').onclick = () => { rcs = !rcs; $('rcsBtn').classList.toggle('is-on', rcs); $('rcsBtn').setAttribute('aria-pressed', String(rcs)); }; $('ascentBtn').onclick = () => { if (!F) return; if (!F.ascentMode && F.descentMode) F.setDescentMode(false); F.ascentMode = !F.ascentMode; syncDescentBtn(); $('ascentBtn').classList.toggle('is-on', F.ascentMode); $('ascentBtn').setAttribute('aria-pressed', String(F.ascentMode)); showToast(F.ascentMode ? 'ASCENT MODE ON' : 'ASCENT MODE OFF'); }; $('chuteBtn').onclick = () => { if (!F) return; showToast(F.deployChute(S)); syncChuteBtn(); }; $('descentBtn').onclick = () => toggleDescentMode();
    $('orbitNodeAdd').onclick = () => { const seconds = Number($('orbitNodeAdd').dataset.time) || 600; $('orbitNodeAdd').classList.add('hidden'); addNodeForCraft(seconds); };
    $('resetBtn').onclick = () => { lock = null; cam.o = { x: 0, y: 0 }; cam.k = innerHeight / (2.5 * AU); }; $('closeDetail').onclick = () => { $('detailPanel').classList.add('hidden'); sel = null; lock = null; }; $('openMapBtn').onclick = openMap; $('surfaceBtn').onclick = () => { if (surfAllowed() || viewMode === 'surface') toggleSurface(); else showToast('NO SOLID SURFACE'); }; $('mapResetBtn').onclick = () => { if (viewMode === 'surface' && mapRenderer && mapRenderer.surf && window.ExolineSurfaceState) { mapRenderer.setSurfaceCenter(window.ExolineSurfaceState.lonDeg, 0); mapRenderer.surf.mPerPx = 50; mapRenderer._syncSurfView(); } else mapRenderer?.reset(); }; $('backBtn').onclick = () => { if (viewMode === 'surface') exitSurface(false); C.style.display = 'block'; $('mapCanvas').style.display = 'none'; $('mapCanvas').classList.add('hidden'); $('mapTopbar').classList.add('hidden'); };
    $('setTargetBtn').onclick = () => { if (sel && ExolineNav.setTarget(sel.id)) showToast(`TARGET: ${ExolineNav.bodyName(sel.id).toUpperCase()}`); else if (sel) showToast('TARGET UNAVAILABLE'); };
    $('navDetailBtn').onclick = () => $('navExtra').classList.toggle('hidden');
    $('navToggle').onclick = () => $('navPanel').classList.toggle('collapsed');
    $('navClearTarget').onclick = () => { ExolineNav.clearTarget(); showToast('TARGET CLEARED'); };
    $('navNodeBtn').onclick = () => addNodeForCraft();
    $('navFocusCraft').onclick = () => { craftSelected = true; sel = null; lock = 'craft'; focusCraftView(); };
    $('navFocusTarget').onclick = () => { const id = ExolineNav.getTarget(); const body = id && D.bodies.find(b => b.id === id); if (body) { sel = body; craftSelected = false; lock = 'body'; } };
    $('navFit').onclick = () => { lock = null; cam.o = { x: 0, y: 0 }; cam.k = innerHeight / (2.5 * AU); };
    $('resetBtn').onclick = resetView;
    $('navTimeMinus').onclick = () => stepNodeTime(-1); $('navTimePlus').onclick = () => stepNodeTime(1);
    $('navNodeDelete').onclick = () => { if (activeNodeId !== null) { nodeAnchors.delete(activeNodeId); ExolineNav.removeNode(activeNodeId); activeNodeId = null; $('navNode').classList.add('hidden'); showToast('MANEUVER NODE DELETED'); } };
    $('navExecute').onclick = () => autoBurn ? cancelAutoBurn() : startAutoBurn();
    // Transfer window computation and auto-transfer
    $('navComputeXfer').onclick = async () => {
      const targetId = ExolineNav.getTarget();
      if (!targetId) { showToast('SET A TARGET FIRST'); return; }
      const xferList = $('navXferList');
      const xferSection = $('navXfer');
      xferSection.classList.remove('hidden');
      xferList.classList.add('hidden');
      xferList.innerHTML = 'COMPUTING...';
      xferList.classList.remove('hidden');
      try {
        const fromId = ExolineNav.currentRefId();
        const windows = ExolineNav.computeTransferWindows(fromId, targetId, 10, 730);
        if (!windows || !windows.length) {
          xferList.innerHTML = '<div class="xfer-item">NO WINDOWS FOUND</div>';
          return;
        }
        xferList.innerHTML = windows.map((w, i) => `
          <div class="xfer-item" data-index="${i}" style="padding:6px 8px;border-bottom:1px solid rgba(255,255,255,.08);cursor:pointer;">
            <div style="font-size:10px;color:#78e5ff;">${w.date.toISOString().slice(0,19).replace('T',' ')} UTC</div>
            <div style="font-size:9px;color:#aaa;">DEP Δv ${ExolineNav.fmtDv(w.dvDeparture)} · ARR Δv ${ExolineNav.fmtDv(w.dvArrival)} · TOF ${ExolineNav.fmtDur(w.tof)}</div>
            <div style="font-size:9px;color:#78e5ff;">TOTAL Δv ${ExolineNav.fmtDv(w.totalDv)}</div>
          </div>
        `).join('');
        // Click handler for each window
        xferList.querySelectorAll('.xfer-item').forEach((el, i) => {
          el.onclick = () => {
            const w = windows[i];
            // computeTransferWindows already solved the arc (Hohmann window for
            // heliocentric transfers, planet-frame Lambert for moon transfers),
            // so use its Δv directly rather than re-solving with a different
            // frame convention.
            const tSec = (w.date - date) / 1000;
            if (!(tSec >= 0)) { showToast('WINDOW IN PAST'); return; }
            if (!(w.dvDeparture > 0)) { showToast('NO VIABLE BURN'); return; }
            const refId = ExolineNav.currentRefId();
            // Departure burn: prograde at the craft's reference body.
            const node = ExolineNav.addNode({ t: tSec, referenceBody: refId, progradeDv: w.dvDeparture, radialDv: 0, normalDv: 0 });
            if (!node) { showToast('NODE CREATION FAILED'); return; }
            // Capture burn at the target, one TOF later: retrograde relative to
            // the target's own frame so it circularises instead of flying past.
            if (w.dvArrival > 0) {
              ExolineNav.addNode({ t: tSec + w.tof, referenceBody: w.arrivalBody, progradeDv: -w.dvArrival, radialDv: 0, normalDv: 0 });
            }
            activeNodeId = node.id;
            $('navNode').classList.remove('hidden');
            $('navPanel').classList.remove('hidden', 'collapsed');
            xferSection.classList.add('hidden');
            ExolineNav.invalidate();
            startAutoBurn();
            showToast(`TRANSFER ARMED · ${ExolineNav.bodyName(w.arrivalBody).toUpperCase()} · T+${ExolineNav.fmtDur(tSec)}`);
          };
        });
      } catch (e) {
        console.error('Transfer window error:', e);
        xferList.innerHTML = '<div class="xfer-item" style="color:#ff7373">ERROR</div>';
      }
    };
    const nodeFields = [['navNodePro', 'progradeDv'], ['navNodeRad', 'radialDv'], ['navNodeNor', 'normalDv']];
    for (const field of nodeFields) { const input = $(field[0]); input.oninput = () => { const nodes = ExolineNav.getNodes(), node = nodes.find(n => n.id === activeNodeId) || nodes[0]; if (node) { ExolineNav.updateNode(node.id, { [field[1]]: input.value }); ExolineNav.setEditing(true); } }; input.onchange = input.onblur = () => ExolineNav.setEditing(false); }

    C.addEventListener('pointerdown', e => {
      const r = C.getBoundingClientRect();
      panning = true;
      panned = false;
      panDrag = { x: e.clientX - r.left, y: e.clientY - r.top, o: { x: cam.o.x, y: cam.o.y } };
      C.setPointerCapture(e.pointerId);
    });
    C.addEventListener('pointermove', e => {
      if (!panning) return;
      const r = C.getBoundingClientRect(), dx = e.clientX - r.left - panDrag.x, dy = e.clientY - r.top - panDrag.y;
      // Dragging always pans; the auto-follow is disabled until the next tap.
      cam.o.x = panDrag.o.x - dx / cam.k;
      cam.o.y = panDrag.o.y + dy / cam.k;
    });
    C.addEventListener('pointerup', e => {
      const moved = panning && Math.hypot(e.clientX - panDrag.x, e.clientY - panDrag.y) >= 4;
      panning = false;
      const r = C.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
      if (moved) { panned = true; return; }
      const nodeHit = nodeHitRegions.find(hit => Math.hypot(hit.x - x, hit.y - y) <= hit.radius);
      if (nodeHit) {
        activeNodeId = nodeHit.id; $('navNode').classList.remove('hidden'); $('navPanel').classList.remove('collapsed'); ExolineNav.setEditing(true);
        setTimeout(() => ExolineNav.setEditing(false), 500);
        return;
      }
      const orbitHit = orbitHitRegions.reduce((best, point) => !best || Math.hypot(point.x - x, point.y - y) < best.distance ? { point, distance: Math.hypot(point.x - x, point.y - y) } : best, null);
      if (orbitHit && orbitHit.distance <= 18) {
        const button = $('orbitNodeAdd'); button.dataset.time = String(orbitHit.point.t); button.style.left = `${Math.min(innerWidth - 104, x + 10)}px`; button.style.top = `${Math.min(innerHeight - 34, y + 10)}px`; button.classList.remove('hidden');
        return;
      }
      const ship = ws(F.s.r), hit = pick(x, y);
      if (Math.hypot(ship.x - x, ship.y - y) < 22) {
        craftSelected = true; sel = null; lock = 'craft'; cam.o = { x: F.s.r.x, y: F.s.r.y }; focusCraftView(); $('detailPanel').classList.add('hidden');
      } else if (hit) {
        inspect(hit);
      } else {
        sel = null; craftSelected = false; lock = null; $('detailPanel').classList.add('hidden');
      }
    });
    C.addEventListener('wheel', e => {
      e.preventDefault();
      const r = C.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
      const before = sw(x, y), factor = e.deltaY < 0 ? 1.22 : 1 / 1.22;
      cam.k = Math.max(1e-12, cam.k * factor);
      const after = sw(x, y);
      cam.o.x += before.x - after.x;
      cam.o.y += before.y - after.y;
    }, { passive: false });
    addEventListener('keydown', e => {
      if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
      if (matches(e, 'pause')) { e.preventDefault(); running = !running; updateWarp(); }
      if (matches(e, 'warpDown')) { e.preventDefault(); setWarp(warpIndex - 1); }
      if (matches(e, 'warpUp')) { e.preventDefault(); setWarp(warpIndex + 1); }
      const node = ExolineNav.getNodes().find(n => n.id === activeNodeId);
      if (node) {
        const amount = e.shiftKey ? 100 : 10;
        const patch = e.key === 'w' || e.key === 'W' ? { progradeDv: node.progradeDv + amount } : e.key === 's' || e.key === 'S' ? { progradeDv: node.progradeDv - amount } : e.key === 'd' || e.key === 'D' ? { radialDv: node.radialDv + amount } : e.key === 'a' || e.key === 'A' ? { radialDv: node.radialDv - amount } : e.key === 'e' || e.key === 'E' ? { normalDv: node.normalDv + amount } : e.key === 'q' || e.key === 'Q' ? { normalDv: node.normalDv - amount } : null;
        if (patch) { e.preventDefault(); ExolineNav.updateNode(node.id, patch); ExolineNav.setEditing(true); setTimeout(() => ExolineNav.setEditing(false), 300); return; }
        if (e.key === ',' || e.key === '<') { e.preventDefault(); stepNodeTime(-1); return; }
        if (e.key === '.' || e.key === '>') { e.preventDefault(); stepNodeTime(1); return; }
      }
      if (e.key === 'ArrowUp') { e.preventDefault(); keys.pan.up = true; }
      if (e.key === 'ArrowDown') { e.preventDefault(); keys.pan.down = true; }
      if (e.key === 'ArrowLeft') { e.preventDefault(); keys.pan.left = true; }
      if (e.key === 'ArrowRight') { e.preventDefault(); keys.pan.right = true; }
      if (e.key === 't' || e.key === 'T') { if (sel && ExolineNav.isTargetable(sel.id)) { ExolineNav.setTarget(sel.id); showToast(`TARGET: ${ExolineNav.bodyName(sel.id).toUpperCase()}`); } }
      if (e.key === 'c' || e.key === 'C') { if (ExolineNav.getTarget()) { ExolineNav.clearTarget(); showToast('TARGET CLEARED'); } }
      // v0.2.0: Enter toggles surface/orbit when allowed; Esc exits surface.
      // While the mission menu owns the screen, Enter belongs to it.
      if (e.code === 'Enter' && !(e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT')) && $('missionScreen') && $('missionScreen').classList.contains('hidden')) { e.preventDefault(); if (surfAllowed() || viewMode === 'surface') toggleSurface(); return; }
      if (e.code === 'Escape' && viewMode === 'surface') { e.preventDefault(); exitSurface(true); return; }
      if (matches(e, 'addNode')) addNodeForCraft();
      if (matches(e, 'focusCraft')) { craftSelected = true; sel = null; lock = 'craft'; focusCraftView(); }
      if (matches(e, 'resetView')) resetView();
      if (matches(e, 'autoBurn')) { if (autoBurn) cancelAutoBurn(); else startAutoBurn(); }
      if (matches(e, 'stage')) { e.preventDefault(); if (F) { const separated = F.stage(); showToast(separated ? 'STAGE SEPARATION' : 'FINAL STAGE — NO SEPARATION'); } }
      if (matches(e, 'chute')) { e.preventDefault(); if (F) { showToast(F.deployChute(S)); syncChuteBtn(); } }
      if (matches(e, 'descent')) { e.preventDefault(); toggleDescentMode(); }
    });
    addEventListener('keyup', e => {
      if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
      if (e.key === 'w' || e.key === 'W' || e.key === 's' || e.key === 'S' || e.key === 'a' || e.key === 'A' || e.key === 'd' || e.key === 'D' || e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        keys.pan.up = false; keys.pan.down = false; keys.pan.left = false; keys.pan.right = false;
      }
    });
  }
  async function frame(now) {
    frameCount++;
    const realSeconds = Math.min(.1, (now - lastFrame) / 1000); lastFrame = now;
    if (running) {
      const requestedSeconds = realSeconds * WARP[warpIndex];
      // Never advance the ephemeris farther than the craft integrator has
      // advanced.  The previous mismatch made a de-orbit see planets/sun at a
      // future epoch and produced non-physical energy changes.
      simulationBacklog += requestedSeconds;
      // The initial circular hold is an exact phase solution, so it can safely
      // absorb any warp interval. Perturbed/de-orbit motion is still RK4
      // stepped, but a 10k warp must be allowed to consume roughly its full
      // requested interval instead of being pinned to five seconds/frame.
      const exactCoast = F.circularHold && F.s.throttle === 0 && !autoBurn;
      const integrationBudget = Math.min(1200, Math.max(5, requestedSeconds));
      const physicsSeconds = exactCoast ? simulationBacklog : Math.min(integrationBudget, simulationBacklog);
      simulationBacklog = Math.max(0, simulationBacklog - physicsSeconds);
      F.s.heading += (Number(!!keys.right) - Number(!!keys.left)) * (rcs ? .7 : 2.2) * realSeconds;
      if (F.descentMode && (keys.left || keys.right)) { F.setDescentMode(false); showToast('DESCENT MODE OFF · MANUAL STEER'); syncDescentBtn(); }
      F.manualSteer = !!(keys.left || keys.right);
      F.steerOverride = !!autoBurn;
      try {
        if (exactCoast) {
          // Analytic circular hold: exact at any warp, single step.
          updateAutoBurn(physicsSeconds); F.step(physicsSeconds, S); finishAutoBurn(physicsSeconds);
          date = new Date(+date + physicsSeconds * 1000);
          await updateStates(); F.syncCircularHold(S); F.syncLanded(S);
        } else {
          // Perturbed flight: split into <=120 s chunks with a fresh ephemeris
          // each chunk, so high warp can't inject energy via stale body
          // positions.
          //
          // Any powered burn is capped hard, at 2 s while auto-burn owns the
          // throttle and 5 s for a manual one. Without this a single 120 s
          // chunk at full thrust delivers 2400 m/s of Δv in one frame, which
          // throws the craft onto a wildly wrong conic and is the classic
          // "I warped while burning and my orbit exploded" failure.
          let remaining = physicsSeconds;
          while (remaining > 1e-9) {
            const powered = F.s.throttle > 0;
            const autoActive = autoBurn && autoBurn.phase !== 'COAST';
            const chunk = Math.min(autoActive ? 2 : powered ? 5 : 120, remaining);
            updateAutoBurn(chunk); F.step(chunk, S); finishAutoBurn(chunk);
            date = new Date(+date + chunk * 1000);
            await updateStates(); F.syncCircularHold(S); F.syncLanded(S);
            remaining -= chunk;
            if (!running) break;
          }
        }
        if (window.ExolinePhysicsAgent) window.ExolinePhysicsAgent.check(frameCount, F, S);
      } catch (error) { console.warn('Flight integration paused:', error); running = false; simulationBacklog = 0; }
    }
    draw(); requestAnimationFrame(frame);
  }
  async function start() { [D, P, A, minerals] = await Promise.all(['solar_system.json', 'physics_constants.json', 'render_anchors.json', 'mineral_profiles.json'].map(async file => (await fetch('../data/' + file)).json())); await ExolineOrbit.load(); await updateStates(); F = new ExolineFlight.Flight(P); const savedOrbit = (() => { try { return localStorage.getItem('exoline.orbitSelect'); } catch { return null; } })(); launchSite(savedOrbit && (P.bodies[savedOrbit] || ORBITAL_LAUNCH_SITES[savedOrbit]) ? savedOrbit : 'earth'); ExolineNav.init({ catalog: D, constants: P, flight: F, getBodies: () => S, getDate: () => date, getRefId: () => soiBody()?.id || F.dominant(S) }); resize(); controls(); setWarp(0); setTimeout(() => { $('introScreen')?.classList.add('is-exiting'); setTimeout(() => { $('introScreen')?.remove(); $('missionScreen')?.classList.remove('hidden'); $('app')?.classList.add('mission-active'); }, 850); }, 4200); requestAnimationFrame(frame); }
  addEventListener('resize', resize);
  start().catch(error => {
    // Do not leave the player behind an opaque splash screen if data or a
    // script fails during startup. The console preserves the technical cause.
    console.error('EXOLINE startup failed:', error);
    $('introScreen')?.remove();
    const loading = $('loading');
    loading?.classList.remove('hidden');
    if ($('loadingText')) $('loadingText').textContent = 'STARTUP ERROR — OPEN CONSOLE';
  });
})();
