// EXOLINE navigation engine — v0.0.4 NAVIGATION + ORBITAL PLANNING.
// Pure mathematics and navigation state. No DOM, no rendering, no pixels.
// Units: distance = m, mass = kg, time = s (physics_constants.json).
// One source of truth for celestial motion: ExolineOrbit.state(id, date).
// One source of truth for the live craft: the Flight engine state.
window.ExolineNav = (() => {
  const DAY = 86400;
  const EPS = 1e-9;
  const MAX_STEPS = 3000;      // hard prediction budget per leg
  const RENDER_POINTS = 700;   // decimated polyline cap for drawing
  const RECOMPUTE_MS = 350;    // wall-clock cadence for heavy recomputes
  const EDIT_MS = 140;         // cadence while a maneuver is being edited

  let ctx = null;              // { catalog, constants, flight, getBodies, getDate }
  let target = null;           // navigation TARGET body id (distinct from craft focus / selection)
  let nodes = [];              // maneuver nodes: PLAN only, live craft untouched
  let seq = 0;
  let predToken = 0;           // stale-result guard: every compute carries the token
  let dirty = true;
  let lastHeavy = 0;
  let snapshot = null;
  let editing = false;
  let cachedPlan = null;       // frozen post-burn plan: computed on edit, drawn as-is
  let planDirty = true;          // set by node edits; rebuilt on next recompute (cadence-limited)
  let lastNavThrottle = 0;
  // Absolute burn epoch (sim ms). node.t stays as compat copy, refreshed from epoch.
  function nodeRemaining(node) { return Math.max(0, (node.epoch - (+ctx.getDate())) / 1000); }

  // ---------- vector helpers (3D) ----------
  const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: (a.z || 0) + (b.z || 0) });
  const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: (a.z || 0) - (b.z || 0) });
  const mul = (a, n) => ({ x: a.x * n, y: a.y * n, z: (a.z || 0) * n });
  const dot = (a, b) => a.x * b.x + a.y * b.y + (a.z || 0) * (b.z || 0);
  const cross = (a, b) => ({
    x: (a.y || 0) * (b.z || 0) - (a.z || 0) * (b.y || 0),
    y: (a.z || 0) * b.x - a.x * (b.z || 0),
    z: a.x * (b.y || 0) - a.y * (b.x || 0)
  });
  const len = a => Math.sqrt(dot(a, a));
  const finiteVec = a => a && Number.isFinite(a.x) && Number.isFinite(a.y) && Number.isFinite(a.z || 0);
  // Zero vectors return null instead of producing invalid geometry.
  const unit = a => { const l = len(a); return l > EPS && Number.isFinite(l) ? mul(a, 1 / l) : null; };
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const copyState = s => ({ r: { x: s.r.x, y: s.r.y, z: s.r.z || 0 }, v: { x: s.v.x, y: s.v.y, z: s.v.z || 0 } });

  // ---------- ephemeris: world position of any body at simulation time ----------
  // Moons stay hierarchical: world = parent world + propagated parent-relative state.
  function worldAtDate(id, date) {
    if (id === 'sun') return { x: 0, y: 0, z: 0 };
    if (!ctx.constants.bodies[id]) return null;
    const s = window.ExolineOrbit.state(id, date);
    if (!s || !finiteVec(s)) return null;
    const AU = ctx.constants.AU_M;
    const point = { x: s.x * AU, y: s.y * AU, z: (s.z || 0) * AU };
    const parentId = ctx.constants.bodies[id] && ctx.constants.bodies[id].parent;
    if (parentId) {
      const host = worldAtDate(parentId, date);
      return host ? add(host, point) : null;
    }
    return point;
  }
  // tSec = seconds from "now" on the simulation clock (never wall-clock).
  function worldAt(id, tSec) {
    return worldAtDate(id, new Date(+ctx.getDate() + tSec * 1000));
  }
  function velocityAt(id, tSec) {
    const ahead = worldAt(id, tSec + 0.5), behind = worldAt(id, tSec - 0.5);
    return ahead && behind ? sub(ahead, behind) : null; // (t+0.5)-(t-0.5) = 1.0 s, m/s
  }
  function liveBody(id) { return ctx.getBodies()[id] || null; }

  function bodyName(id) {
    if (id === 'sun') return 'Sun';
    const found = ctx.catalog.bodies.find(b => b.id === id);
    return found ? found.name : String(id || '').toUpperCase();
  }
  function isTargetable(id) {
    if (!id || id === 'sun') return false;
    return !!(ctx.catalog.bodies.find(b => b.id === id));
  }

  // ---------- local orbital frame (prograde / radial / normal) ----------
  // Derived from physical vectors — never hard-coded axes.
  function getVelocityFrame(craftState, refId, tSec = 0) {
    const bodies = ctx.getBodies();
    let refPos, refVel;
    if (tSec) {
      refPos = worldAt(refId, tSec);
      refVel = velocityAt(refId, tSec);
    } else {
      const live = bodies[refId];
      if (!live) return null;
      refPos = { x: live.x, y: live.y, z: live.z || 0 };
      refVel = { x: live.vx || 0, y: live.vy || 0, z: live.vz || 0 };
    }
    if (!refPos) return null;
    const rRel = sub(craftState.r, refPos);
    const vRel = sub(craftState.v, refVel);
    const ePro = unit(vRel);
    const eRad = unit(rRel);
    if (!ePro || !eRad) return null;
    const eNor = unit(cross(eRad, ePro));
    if (!eNor) return null; // degenerate: velocity parallel to radius
    return { prograde: ePro, radial: eRad, normal: eNor, rRel, vRel, referenceBody: refId };
  }

  // ---------- relative navigation state ----------
  // r_rel = r_spacecraft - r_target ; radial = dot(r_rel, v_rel)/|r_rel|
  // radial < 0 = approaching, > 0 = receding.
  function getRelativeState(craftState = ctx.flight.s, bodyId = target, tSec = 0) {
    if (!bodyId) return null;
    if (!ctx.constants.bodies[bodyId]) return null;
    let tPos, tVel, tPhys;
    if (tSec) {
      tPos = worldAt(bodyId, tSec);
      tVel = velocityAt(bodyId, tSec);
      tPhys = ctx.constants.bodies[bodyId];
    } else {
      const live = liveBody(bodyId);
      tPhys = ctx.constants.bodies[bodyId];
      if (live) { tPos = { x: live.x, y: live.y, z: live.z || 0 }; tVel = { x: live.vx || 0, y: live.vy || 0, z: live.vz || 0 }; }
    }
    if (!tPos || !tVel || !tPhys) return null;
    const rRel = sub(craftState.r, tPos);
    const vRel = sub(craftState.v, tVel);
    const distance = len(rRel);
    if (!Number.isFinite(distance) || distance < EPS) return null;
    const radial = dot(rRel, vRel) / distance;
    return {
      bodyId, distance, altitude: distance - (tPhys.radius_m || 0),
      radial, closing: -radial, speedRel: len(vRel),
      rRel, vRel, tSec
    };
  }

  // ---------- orbital elements of the craft about a reference body ----------
  // eps = v^2/2 - mu/r ; a = -mu/(2 eps) ; h = r x v ;
  // e_vec = ((v^2 - mu/r) r - (r.v) v)/mu ; rp = p/(1+e) ; ra = p/(1-e) for e<1.
  function getOrbitalElements(craftState = ctx.flight.s, refId = null, tSec = 0) {
    refId = refId || currentRefId();
    const physical = ctx.constants.bodies[refId];
    if (!physical) return null;
    let refPos, refVel;
    if (tSec) {
      refPos = worldAt(refId, tSec);
      refVel = velocityAt(refId, tSec);
    } else {
      const live = liveBody(refId);
      if (!live) return null;
      refPos = { x: live.x, y: live.y, z: live.z || 0 };
      refVel = { x: live.vx || 0, y: live.vy || 0, z: live.vz || 0 };
    }
    if (!refPos || !refVel) return null;
    const mu = ctx.constants.G * physical.mass;
    if (!(mu > 0)) return null;
    const r = sub(craftState.r, refPos), v = sub(craftState.v, refVel);
    const distance = len(r), speed = len(v);
    if (!(distance > EPS) || !finiteVec(r) || !finiteVec(v)) return null;
    const energy = speed * speed / 2 - mu / distance;         // specific orbital energy
    const hVec = cross(r, v);                                  // specific angular momentum
    const h = len(hVec);
    const rv = dot(r, v);
    const eccVec = mul(sub(mul(r, (speed * speed - mu / distance)), mul(v, rv)), 1 / mu);
    const ecc = len(eccVec);
    const p = h * h / mu;                                      // semi-latus rectum
    const bound = ecc < 1 && energy < 0;
    const semiMajor = Math.abs(energy) > EPS ? -mu / (2 * energy) : Infinity;
    const peri = p / (1 + ecc);                                // valid for e<1 and e>1
    const apo = ecc < 1 ? p / (1 - ecc) : null;                // hyperbolic: undefined -> ESCAPE
    const period = bound && semiMajor > 0 ? 2 * Math.PI * Math.sqrt(semiMajor ** 3 / mu) : null;
    const inc = h > EPS ? Math.acos(clamp(hVec.z / h, -1, 1)) : null;
    const label = !bound ? 'ESCAPE' : 'BOUND';
    return {
      referenceBody: refId, mu, distance, speed, energy, hVec, h, eccVec, ecc, e: ecc, p,
      a: bound ? semiMajor : null, semiMajor, peri, apo, period, bound, label,
      inc: inc === null ? null : inc * 180 / Math.PI,
      vEsc: Math.sqrt(2 * mu / distance),                      // escape velocity at distance
      radial: distance > EPS ? rv / distance : 0,
      rRel: r, vRel: v, radius: physical.radius_m || 0
    };
  }

  // Navigation reference is supplied by the flight/SOI layer when available;
  // otherwise use the current gravity-dominant body (never the target by fiat).
  function currentRefId() { return ctx.getRefId?.() || ctx.flight.dominant(ctx.getBodies()); }

  // ---------- sphere of influence: r_SOI = a (m/M)^(2/5) ----------
  function soiRadius(id) {
    if (!id || id === 'sun') return null;
    const physical = ctx.constants.bodies[id];
    if (!physical) return null;
    // Primary planets and dwarf planets are Sun-orbiting bodies even though
    // the compact physics catalog does not repeat parent: "sun" for each.
    const parentId = physical.parent || 'sun';
    if (!parentId) return null;
    const parent = ctx.constants.bodies[parentId];
    if (!parent) return null;
    const s = window.ExolineOrbit.state(id, ctx.getDate());
    if (!s) return null;
    const aAU = s.a !== undefined ? s.a : s.r; // primary/dwarf expose .a, moons expose .r
    if (!Number.isFinite(aAU) || !(aAU > 0)) return null;
    const a = aAU * ctx.constants.AU_M;
    return a * Math.pow(physical.mass / parent.mass, 2 / 5);
  }

  // ---------- prediction: ephemeris grid + adaptive RK4 coast ----------
  // Body motion over the leg is sampled once onto a grid and interpolated,
  // so each RK4 evaluation stays cheap while remaining on the real ephemeris.
  function buildGrid(ids, tStart, horizon) {
    const spacing = clamp(horizon / 192, 30, 3600);
    const count = Math.min(1500, Math.max(2, Math.ceil(horizon / spacing) + 1));
    const step = horizon / (count - 1);
    const grid = { ids, tStart, spacing: step, count, points: {} };
    for (const id of ids) {
      const column = new Float64Array(count * 3);
      for (let i = 0; i < count; i++) {
        const p = worldAt(id, tStart + i * step);
        column[i * 3] = p ? p.x : 0; column[i * 3 + 1] = p ? p.y : 0; column[i * 3 + 2] = p ? p.z : 0;
      }
      grid.points[id] = column;
    }
    return grid;
  }
  function gridAt(grid, id, tAbs) {
    const column = grid.points[id];
    if (!column) return null;
    const f = clamp((tAbs - grid.tStart) / grid.spacing, 0, grid.count - 1);
    const i = Math.min(grid.count - 2, Math.floor(f)), u = f - i;
    const a = i * 3, b = (i + 1) * 3;
    const pt = {
      x: column[a] + (column[b] - column[a]) * u,
      y: column[a + 1] + (column[b + 1] - column[a + 1]) * u,
      z: column[a + 2] + (column[b + 2] - column[a + 2]) * u
    };
    pt.r = { x: pt.x, y: pt.y, z: pt.z };
    return pt;
  }
  // Keep only bodies whose pull matters for this leg (dominant always kept).
  // Same Newtonian model as the flight engine — not a second gravity model.
  function selectBodies(tStart, craftState) {
    const constants = ctx.constants, pulls = [];
    let greatest = 0;
    for (const [id, physical] of Object.entries(constants.bodies)) {
      const pos = worldAt(id, tStart);
      if (!pos) continue;
      const d = len(sub(craftState.r, pos));
      if (!(d > EPS)) continue;
      const pull = constants.G * physical.mass / (d * d);
      pulls.push({ id, pull });
      if (pull > greatest) greatest = pull;
    }
    const floor = greatest * 1e-5;
    return pulls.filter(p => p.pull >= floor).map(p => p.id);
  }
  function gridDominant(grid, craftState, tAbs) {
    let id = grid.ids[0], greatest = 0;
    for (const bodyId of grid.ids) {
      const pos = gridAt(grid, bodyId, tAbs);
      const physical = ctx.constants.bodies[bodyId];
      if (!pos || !physical) continue;
      const d = len(sub(craftState.r, pos));
      if (!(d > EPS)) continue;
      const pull = ctx.constants.G * physical.mass / (d * d);
      if (pull > greatest) { greatest = pull; id = bodyId; }
    }
    return id;
  }
  function gravityAcc(grid) {
    const constants = ctx.constants, gm = {}, craftMass = ctx.flight.s.m;
    for (const id of grid.ids) gm[id] = constants.G * constants.bodies[id].mass;
    return (position, tAbs, velocity = { x: 0, y: 0, z: 0 }) => {
      let acc = { x: 0, y: 0, z: 0 };
      for (const id of grid.ids) {
        const body = gridAt(grid, id, tAbs);
        if (!body) continue;
        const dx = position.x - body.x, dy = position.y - body.y, dz = position.z - body.z;
        const squared = dx * dx + dy * dy + dz * dz;
        if (squared <= 1) continue;
        const k = -gm[id] / (squared * Math.sqrt(squared));
        acc.x += dx * k; acc.y += dy * k; acc.z += dz * k;
        // Avoid an allocation for every non-atmospheric body in the preview.
        if (window.ExolineFlight.atmospheres?.[id] && window.ExolineFlight.atmosphericDrag) {
          const drag = window.ExolineFlight.atmosphericDrag(position, velocity, body, { ...constants.bodies[id], id }, craftMass);
          acc.x += drag.x; acc.y += drag.y; acc.z += drag.z;
        }
      }
      return acc;
    };
  }
  function pickHorizon(tStart, craftState, refId) {
    const physical = ctx.constants.bodies[refId];
    const refPos = worldAt(refId, tStart);
    if (!physical || !refPos) return 6 * 3600;
    const mu = ctx.constants.G * physical.mass;
    const r = len(sub(craftState.r, refPos));
    const v = len(sub(craftState.v, velocityAt(refId, tStart) || { x: 0, y: 0, z: 0 }));
    const energy = v * v / 2 - mu / Math.max(r, EPS);
    let horizon;
    if (energy < 0) {
      const a = -mu / (2 * energy);
      horizon = 2 * Math.PI * Math.sqrt(a ** 3 / mu);        // one orbital period
    } else {
      const soi = soiRadius(refId) || 4 * r;
      horizon = 3 * Math.max(soi - r, r) / Math.max(v, 500); // time to leave the neighborhood
    }
    horizon = clamp(horizon, 3600, 120 * DAY);
    if (target) {                                             // reach out toward the encounter
      const rel = getRelativeState(craftState, target, tStart);
      if (rel && rel.closing > 1) horizon = Math.max(horizon, Math.min(rel.distance / rel.closing * 2.2, 150 * DAY));
    }
    return clamp(horizon, 3600, 150 * DAY);
  }

  // One coast leg: adaptive RK4 steps scaled by the local orbital period.
  // Never mutates the live craft — operates purely on the passed-in state.
  function propagateLeg(startState, tStart, horizon, track) {
    const ids = selectBodies(tStart, startState);
    if (!ids.length) return null;
    const grid = buildGrid(ids, tStart, horizon);
    const acc = gravityAcc(grid);
    const state = copyState(startState);
    const records = [];
    let t = 0, steps = 0, impact = false;
    let targetGrid = null;
    if (track && target) targetGrid = buildGrid([target], tStart, horizon);
    let best = null; // { index, distance }
    while (t < horizon - 1e-6 && steps < MAX_STEPS) {
      const tAbs = tStart + t;
      const domId = gridDominant(grid, state, tAbs);
      const physical = ctx.constants.bodies[domId];
      const domPos = gridAt(grid, domId, tAbs);
      const radius = len(sub(state.r, domPos));
      const period = 2 * Math.PI * Math.sqrt(Math.max(radius, 1) ** 3 / (ctx.constants.G * physical.mass));
      let atmosphereLimit = Infinity;
      if (window.ExolineFlight.atmosphereStepLimit) {
        const localBodies = {};
        for (const id of ids) localBodies[id] = gridAt(grid, id, tAbs);
        atmosphereLimit = window.ExolineFlight.atmosphereStepLimit(state.r, state.v, localBodies, ctx.constants, ctx.flight.s.m);
      }
      const dt = Math.min(Math.max(.002, Math.min(300, period / 960)), atmosphereLimit, horizon - t);
      window.ExolineFlight.rk4Step(state, dt, (r, off, v) => acc(r, tAbs + off, v));
      t += dt; steps++;
      if (!finiteVec(state.r) || !finiteVec(state.v)) break;
      for (const id of ids) {
        const phys = ctx.constants.bodies[id];
        const pos = gridAt(grid, id, tAbs + dt);
        if (phys && len(sub(state.r, pos)) < phys.radius_m) { impact = true; break; }
      }
      if (targetGrid) {
        const tPos = gridAt(targetGrid, target, tAbs + dt);
        const distance = len(sub(state.r, tPos));
        if (Number.isFinite(distance) && (!best || distance < best.distance)) best = { index: records.length, distance };
      }
      records.push({ t: tStart + t, r: { x: state.r.x, y: state.r.y, z: state.r.z }, v: { x: state.v.x, y: state.v.y, z: state.v.z } });
      if (impact) break;
    }
    let approach = null;
    if (best && targetGrid && records.length > 2) {
      approach = closestApproachIn(records, targetGrid, best);
      approach.atHorizon = best.index >= records.length - 2 || t >= horizon - 1e-3;
      approach.truncated = steps >= MAX_STEPS;
    }
    const points = records.slice(0, RENDER_POINTS).map(r => ({ r: r.r, v: r.v, t: r.t }));
    return {
      records, points, endState: copyState(state), tStart, tEnd: tStart + t,
      startR: { x: startState.r.x, y: startState.r.y, z: startState.r.z || 0 },
      steps, impact, truncated: steps >= MAX_STEPS, approach, horizon, targetId: target
    };
  }
  // Local minimum refinement: parabolic vertex over the three samples around
  // the smallest distance — no false "collision" claims, just encounter info.
  function closestApproachIn(records, targetGrid, best) {
    const i = best.index !== undefined ? best.index : 0;
    const distAt = rec => len(sub(rec.r, gridAt(targetGrid, target, rec.t)));
    let tca = records[i].t, miss = best.distance, index = i;
    if (i > 0 && i < records.length - 1) {
      const d0 = distAt(records[i - 1]), d1 = distAt(records[i]), d2 = distAt(records[i + 1]);
      const denom = d0 - 2 * d1 + d2;
      if (Math.abs(denom) > EPS) {
        const frac = clamp(0.5 * (d0 - d2) / denom, -1, 1);
        const span = records[i + 1].t - records[i - 1].t;
        tca = records[i - 1].t + (0.5 + frac * 0.5) * span;
        miss = d1 - 0.25 * (d0 - d2) * frac;
        if (!(miss > 0) || !Number.isFinite(miss)) miss = best.distance;
      }
    }
    const craftAt = sampleAt(records, tca);
    const targetPos = gridAt(targetGrid, target, tca);
    const targetAhead = gridAt(targetGrid, target, tca + 0.5);
    const targetBehind = gridAt(targetGrid, target, tca - 0.5);
    const relState = craftAt && targetPos && targetAhead && targetBehind ? {
      vRel: sub(craftAt.v, sub(targetAhead, targetBehind)),
      rRel: sub(craftAt.r, targetPos)
    } : null;
    const radial = relState ? dot(relState.rRel, relState.vRel) / Math.max(len(relState.rRel), EPS) : 0;
    return {
      distance: miss, tca, tSec: tca - records[0].t,
      relSpeed: relState ? len(relState.vRel) : null,
      radial, point: craftAt ? craftAt.r : records[i].r, index
    };
  }
  function sampleAt(records, tAbs) {
    if (!records.length) return null;
    if (tAbs <= records[0].t) return records[0];
    if (tAbs >= records[records.length - 1].t) return records[records.length - 1];
    let lo = 0, hi = records.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; (records[mid].t <= tAbs ? lo = mid : hi = mid); }
    const a = records[lo], b = records[hi];
    const u = (tAbs - a.t) / Math.max(b.t - a.t, EPS);
    return {
      t: tAbs,
      r: { x: a.r.x + (b.r.x - a.r.x) * u, y: a.r.y + (b.r.y - a.r.y) * u, z: a.r.z + (b.r.z - a.r.z) * u },
      v: { x: a.v.x + (b.v.x - a.v.x) * u, y: a.v.y + (b.v.y - a.v.y) * u, z: a.v.z + (b.v.z - a.v.z) * u }
    };
  }
  // Public: predict a coast trajectory from an arbitrary state (prediction-only).
  function predictTrajectory(opts = {}) {
    if (!ctx) return null;
    const start = opts.state ? copyState(opts.state) : (opts.craftState ? copyState(opts.craftState) : copyState(ctx.flight.s));
    const tStart = opts.tSec !== undefined ? opts.tSec : (opts.t || 0);
    const refId = opts.refId || opts.referenceBody || currentRefId();
    const horizon = opts.horizon || pickHorizon(tStart, start, refId);
    const leg = propagateLeg(start, tStart, horizon, opts.trackTarget !== false && !!target);
    if (!leg) return null;
    leg.points = leg.records.slice(0, opts.maxSteps || RENDER_POINTS).map(r => ({ r: r.r, v: r.v, t: r.t }));
    return leg;
  }
  // Public: closest approach of a predicted leg toward the active target.
  function getClosestApproach(leg, targetId = target) {
    if (!leg || !leg.approach) return null;
    if (targetId && leg.targetId && targetId !== leg.targetId) return null;
    return leg.approach;
  }

  // ---------- maneuver nodes: a PLAN, never the live craft ----------
  function calculateBurn(node) {
    if (!node) return null;
    const pro = Number(node.progradeDv !== undefined ? node.progradeDv : (node.prograde || 0)) || 0;
    const rad = Number(node.radialDv !== undefined ? node.radialDv : (node.radial || 0)) || 0;
    const nor = Number(node.normalDv !== undefined ? node.normalDv : (node.normal || 0)) || 0;
    const total = Math.sqrt(pro * pro + rad * rad + nor * nor);
    return { prograde: pro, radial: rad, normal: nor, total, finite: Number.isFinite(total) };
  }
function createManeuverNode(opts = {}) {
    const pro = Number(opts.progradeDv !== undefined ? opts.progradeDv : (opts.prograde || 0)) || 0;
    const rad = Number(opts.radialDv !== undefined ? opts.radialDv : (opts.radial || 0)) || 0;
    const nor = Number(opts.normalDv !== undefined ? opts.normalDv : (opts.normal || 0)) || 0;
    const t = Math.max(0, Number(opts.t) || 0);
    const node = {
      id: ++seq,
      t,
      epoch: (+ctx.getDate()) + t * 1000, // absolute sim ms of burn: never drifts
      referenceBody: opts.referenceBody || opts.body || currentRefId(),
      progradeDv: pro,
      radialDv: rad,
      normalDv: nor
    };
    node.totalDv = calculateBurn(node).total;
    node.dv_vec = { x: 0, y: 0, z: 0 }; // frozen inertial burn vector, solved in buildPlan
    node.predictedState = null;
    return node;
  }
  // dv_vec = pro*prograde + rad*radial + nor*normal in the frame at burn time.
  function applyBurnToPreview(state, node, frame = null) {
    const f = frame || getVelocityFrame(state, node.referenceBody || currentRefId(), node.t || 0);
    if (!f) return copyState(state); // degenerate frame: pass state through unchanged
    const burn = calculateBurn(node);
    const dv = add(
      add(mul(f.prograde, burn.prograde), mul(f.radial, burn.radial)),
      mul(f.normal, burn.normal)
    );
    return { r: { x: state.r.x, y: state.r.y, z: state.r.z || 0 }, v: add(state.v, dv) };
  }
  function addNode(opts) { const node = createManeuverNode(opts); nodes.push(node); predToken++; dirty = true; planDirty = true; return node; }
  function updateNode(id, patch = {}) {
    if (!id || !patch) return null;
    const node = nodes.find(n => n.id === id);
    if (!node) return null;
    if (patch.t !== undefined) { node.epoch = (+ctx.getDate()) + Math.max(0, Number(patch.t) || 0) * 1000; node.t = Math.max(0, Number(patch.t) || 0); }
    if (patch.progradeDv !== undefined) node.progradeDv = Number(patch.progradeDv) || 0;
    else if (patch.prograde !== undefined) node.progradeDv = Number(patch.prograde) || 0;
    if (patch.radialDv !== undefined) node.radialDv = Number(patch.radialDv) || 0;
    else if (patch.radial !== undefined) node.radialDv = Number(patch.radial) || 0;
    if (patch.normalDv !== undefined) node.normalDv = Number(patch.normalDv) || 0;
    else if (patch.normal !== undefined) node.normalDv = Number(patch.normal) || 0;
    if (patch.referenceBody) node.referenceBody = patch.referenceBody;
    else if (patch.body) node.referenceBody = patch.body;
    node.totalDv = calculateBurn(node).total;
    predToken++; dirty = true; planDirty = true; // solved once in buildPlan (cadence-limited)
    return node;
  }
  function removeNode(id) { nodes = nodes.filter(n => n.id !== id); predToken++; dirty = true; planDirty = true; }
  function clearNodes() { nodes = []; predToken++; dirty = true; planDirty = true; }
  function getNodes() { return nodes; }
  function setEditing(flag) { editing = !!flag; }

  // ---------- preview: current path + planned (post-burn) path ----------
  // Heavy and synchronous; guarded by predToken so a stale result can never
  // overwrite the state of a newer target/node configuration.
  function buildPreview() {
    const token = predToken;
    const live = ctx.flight.s;
    const base = propagateLeg(live, 0, pickHorizon(0, live, currentRefId()), true);
    if (base) base.builtAt = (+ctx.getDate());
    return { base, plan: cachedPlan, token, predToken: token, refId: currentRefId(), targetId: target };
  }

  function buildPlan() {
    if (!nodes.length) { cachedPlan = null; return; }
    const live = ctx.flight.s;
    for (const n of nodes) n.t = nodeRemaining(n); // refresh compat copy from epoch
    const ordered = [...nodes].sort((a, b) => a.t - b.t);

    // Propagate to first node from live state (edit-time solve only)
    const firstNode = ordered[0];
    const firstLeg = propagateLeg(live, 0, Math.max(firstNode.t, 1), false);
    if (!firstLeg || !firstLeg.records.length) { cachedPlan = null; return; }

    const segments = [], marks = [];
    let state = firstLeg.endState;
    let t0 = firstNode.t;
    let dvTotal = 0;

    // Apply first node burn, freezing the inertial burn vector
    const firstFrame = getVelocityFrame(state, firstNode.referenceBody, firstNode.t);
    if (!firstFrame) { cachedPlan = null; return; }
    const firstBurn = calculateBurn(firstNode);
    firstNode.dv_vec = add(
      add(mul(firstFrame.prograde, firstBurn.prograde), mul(firstFrame.radial, firstBurn.radial)),
      mul(firstFrame.normal, firstBurn.normal)
    );
    firstNode.predictedState = copyState(state);
    state = applyBurnToPreview(state, firstNode, firstFrame);
    dvTotal += firstBurn.total;
    // Burn point frozen RELATIVE to the planet: drawn at live body position +
    // offset, so the marker sits exactly on the planet-frame (blue) orbit.
    const firstBody = worldAt(firstNode.referenceBody, firstNode.t);
    marks.push({ node: firstNode, point: { ...firstLeg.endState.r }, rel: firstBody ? { x: firstLeg.endState.r.x - firstBody.x, y: firstLeg.endState.r.y - firstBody.y } : null, refId: firstNode.referenceBody, frame: firstFrame });

    // Process remaining nodes
    for (let i = 1; i < ordered.length; i++) {
      const node = ordered[i];
      const legT = Math.max(node.t - t0, 1);
      const leg = propagateLeg(state, t0, legT, false);
      if (!leg || !leg.records.length) break;
      leg.node = node;
      segments.push(leg);
      const frame = getVelocityFrame(leg.endState, node.referenceBody, node.t);
      if (!frame) break;
      const b = calculateBurn(node);
      node.dv_vec = add(
        add(mul(frame.prograde, b.prograde), mul(frame.radial, b.radial)),
        mul(frame.normal, b.normal)
      );
      node.predictedState = copyState(leg.endState);
      state = applyBurnToPreview(leg.endState, node, frame);
      dvTotal += b.total;
      const legBody = worldAt(node.referenceBody, node.t);
      marks.push({ node, point: { ...leg.endState.r }, rel: legBody ? { x: leg.endState.r.x - legBody.x, y: leg.endState.r.y - legBody.y } : null, refId: node.referenceBody, frame });
      t0 = Math.max(node.t, leg.tEnd);
    }

    // Final coast leg (frozen inertial records = the fixed target path)
    const finalLeg = propagateLeg(state, t0, pickHorizon(t0, state, currentRefId()), true);
    if (finalLeg) {
      finalLeg.node = ordered[ordered.length - 1];
      segments.push(finalLeg);
      // Planet-relative copy of the post-burn path, solved once here: the
      // renderer adds the body's LIVE position, so the path follows the planet
      // and never jitters. rec.t is seconds-from-build, matching worldAt().
      const refId = firstNode.referenceBody;
      const rel = (pt, tSec) => {
        const bp = refId === 'sun' ? { x: 0, y: 0 } : worldAt(refId, tSec);
        if (!bp) return null;
        return { x: pt.x - bp.x, y: pt.y - bp.y };
      };
      let relRecords = null, relApproach = null, relImpact = null;
      if (refId) {
        const stride = Math.max(1, Math.ceil(finalLeg.records.length / 700));
        relRecords = [];
        for (let i = 0; i < finalLeg.records.length; i += stride) {
          const rec = finalLeg.records[i], q = rel(rec.r, rec.t);
          if (q) relRecords.push(q);
        }
        const last = finalLeg.records[finalLeg.records.length - 1];
        if (last) {
          const q = rel(last.r, last.t);
          if (q) { relRecords.push(q); if (finalLeg.impact) relImpact = q; }
        }
        if (finalLeg.approach && finalLeg.approach.point) {
          relApproach = rel(finalLeg.approach.point, finalLeg.tStart + (finalLeg.approach.tSec || 0));
        }
      }
      cachedPlan = { segments, marks, dvTotal, approach: finalLeg.approach, impact: finalLeg.impact, find: id => ordered.find(n => n.id === id), local: frozenLocalOrbit(state, firstNode.referenceBody, t0), refId, builtAt: (+ctx.getDate()), relRecords, relApproach, relImpact };
    } else {
      cachedPlan = null;
    }
  }
  // Frozen post-burn orbit shape (inertial orientation) for a rock-stable ellipse.
  // Drawn each frame around the body's LIVE position, so it tracks the planet
  // without ever changing shape unless the node is edited.
  function frozenLocalOrbit(postBurnState, refId, tSec) {
    const physical = ctx.constants.bodies[refId];
    if (!physical) return null;
    const refPos = worldAt(refId, tSec), refVel = velocityAt(refId, tSec);
    if (!refPos || !refVel) return null;
    const mu = ctx.constants.G * physical.mass;
    if (!(mu > 0)) return null;
    const r = sub(postBurnState.r, refPos), v = sub(postBurnState.v, refVel);
    const R = len(r);
    if (!(R > EPS)) return null;
    const h = r.x * v.y - r.y * v.x, p = h * h / mu;
    const ev = {
      x: (((v.x * v.x + v.y * v.y) - mu / R) * r.x - (r.x * v.x + r.y * v.y) * v.x) / mu,
      y: (((v.x * v.x + v.y * v.y) - mu / R) * r.y - (r.x * v.x + r.y * v.y) * v.y) / mu
    };
    const e = Math.hypot(ev.x, ev.y);
    if (!(e < 1)) return null; // escape/impact: polyline only
    const a = p / Math.max(1e-12, 1 - e * e);
    if (!(a > 0)) return null;
    const ex = e > 1e-6 ? { x: ev.x / e, y: ev.y / e } : { x: r.x / R, y: r.y / R };
    const perp = { x: -ex.y, y: ex.x };
    // Anomaly at the burn point (node position) in the new orbit
    const cosNu = (r.x * ex.x + r.y * ex.y) / R;
    const sinNu = (r.x * perp.x + r.y * perp.y) / R;
    const nodeAnomaly = Math.atan2(sinNu, cosNu);
    return { refId, a, e, ex, perp, nodeAnomaly };
  }
  // Explicit execution validation (PART 17): returns a plan to commit, or a reason.
  function prepareExecution() {
    if (!nodes.length) return { ok: false, reason: 'NO NODE' };
    for (const n of nodes) n.t = nodeRemaining(n);
    const node = [...nodes].sort((a, b) => a.t - b.t)[0];
    if (!Number.isFinite(node.t) || node.t < 0) return { ok: false, reason: 'BAD TIME' };
    const burn = calculateBurn(node);
    if (!burn.finite) return { ok: false, reason: 'BAD Δv' };
    if (node.t < 1e-6) {
      const frame = getVelocityFrame(ctx.flight.s, node.referenceBody, 0);
      if (!frame) return { ok: false, reason: 'BAD FRAME' };
      return { ok: true, node, endState: applyBurnToPreview(ctx.flight.s, node, frame), t: 0, burn, frame };
    }
    const leg = propagateLeg(ctx.flight.s, 0, node.t, false);
    if (!leg || !leg.records.length) return { ok: false, reason: 'PREDICTION FAILED' };
    if (leg.impact) return { ok: false, reason: 'IMPACT BEFORE NODE' };
    const frame = getVelocityFrame(leg.endState, node.referenceBody, node.t);
    if (!frame) return { ok: false, reason: 'BAD FRAME' };
    return { ok: true, node, endState: applyBurnToPreview(leg.endState, node, frame), t: node.t, burn, leg, frame };
  }
  function commitExecution(nodeId) {
    const executedNode = nodes.find(n => n.id === nodeId);
    nodes = nodes.filter(n => n.id !== nodeId); // epochs are absolute: survivors need no shift
    predToken++; dirty = true; planDirty = true;
    return { ok: true, nodeId, executedNode };
  }

  // ---------- basic transfer planning (analytic approximation, clearly labelled) ----------
  function hohmann(mu, r1, r2, fromId, toId, method) {
    if (!(r1 > 0) || !(r2 > 0) || Math.abs(r2 - r1) < EPS) return null;
    const aTransfer = (r1 + r2) / 2;
    const time = Math.PI * Math.sqrt(aTransfer ** 3 / mu);
    const dvDeparture = Math.abs(Math.sqrt(mu * (2 / r1 - 1 / aTransfer)) - Math.sqrt(mu / r1));
    const dvArrival = Math.abs(Math.sqrt(mu * (2 / r2 - 1 / aTransfer)) - Math.sqrt(mu / r2));
    const total = dvDeparture + dvArrival;
    return {
      from: fromId, to: toId, method, approximate: true,
      dvDeparture, dvArrival, total, dvMag: total, timeSeconds: time,
      packages: [
        { label: 'DEPARTURE', dv: dvDeparture },
        { label: 'ARRIVAL', dv: dvArrival }
      ]
    };
  }
  function getTransferEstimate(fromId, toId) {
    if (!ctx || !fromId || !toId || fromId === toId) return null;
    const constants = ctx.constants;
    const fromP = constants.bodies[fromId], toP = constants.bodies[toId];
    if (!fromP || !toP) return null;
    // Earth -> Moon style: target orbits the departure body (patched estimate).
    if (toP.parent && toP.parent === fromId) {
      const mu = constants.G * fromP.mass;
      const craftEl = getOrbitalElements(ctx.flight.s, fromId);
      const tState = window.ExolineOrbit.state(toId, ctx.getDate());
      if (!tState) return null;
      const aAU = tState.a !== undefined ? tState.a : tState.r;
      const r2 = aAU * constants.AU_M;
      const r1 = craftEl ? craftEl.distance : fromP.radius_m + 180000;
      if (!(r2 > r1)) return null;
      return hohmann(mu, r1, r2, fromId, toId, 'PATCHED');
    }
    // Heliocentric: both bodies orbit the Sun directly.
    if (!fromP.parent && !toP.parent && fromId !== 'sun' && toId !== 'sun') {
      const sun = constants.bodies.sun;
      if (!sun) return null;
      const mu = constants.G * sun.mass;
      const s1 = window.ExolineOrbit.state(fromId, ctx.getDate());
      const s2 = window.ExolineOrbit.state(toId, ctx.getDate());
      if (!s1 || !s2) return null;
      return hohmann(mu, s1.a * constants.AU_M, s2.a * constants.AU_M, fromId, toId, 'HOHMANN');
    }
    return null;
  }

  // ---------- display formatting: no fake precision, no NaN/Infinity ----------
  const fmtInt = n => Math.round(n).toLocaleString('en-US');
  function fmtDistance(m) {
    if (m === null || m === undefined || !Number.isFinite(m)) return '—';
    const abs = Math.abs(m);
    if (abs < 1000) return `${Math.round(m)} m`;
    const km = m / 1000;
    if (abs < 1.5e10) return km < 1e6 ? `${fmtInt(km)} km` : `${(km / 1e6).toFixed(1)}M km`;
    return `${(m / (149597870700)).toFixed(3)} AU`;
  }
  function fmtSpeed(ms) {
    if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
    return Math.abs(ms) < 1000 ? `${ms.toFixed(1)} m/s` : `${(ms / 1000).toFixed(2)} km/s`;
  }
  function fmtSignedSpeed(ms) {
    if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
    const sign = ms > 0.05 ? '+' : ms < -0.05 ? '−' : '';
    const abs = Math.abs(ms);
    return `${sign}${abs < 1000 ? abs.toFixed(1) : (abs / 1000).toFixed(2)}${abs < 1000 ? ' m/s' : ' km/s'}`;
  }
  function fmtDur(s) {
    if (s === null || s === undefined || !Number.isFinite(s) || s < 0) return '—';
    if (s < 60) return `${Math.round(s)}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
    if (s < DAY) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
    return `${Math.floor(s / DAY)}d ${Math.floor((s % DAY) / 3600)}h`;
  }
  const fmtEcc = e => (e === null || e === undefined || !Number.isFinite(e)) ? '—' : e.toFixed(4);
  function fmtApo(els) {
    if (!els) return '—';
    if (!els.bound || !Number.isFinite(els.apo)) return 'ESCAPE';
    return fmtDistance(Math.max(0, els.apo - (els.radius || 0)));
  }
  const fmtPeri = els => (!els || !Number.isFinite(els.peri)) ? '—' : fmtDistance(Math.max(0, els.peri - (els.radius || 0)));
  function fmtEnergy(e) {
    if (e === null || e === undefined || !Number.isFinite(e)) return '—';
    return `${e >= 0 ? '+' : '−'}${(Math.abs(e) / 1e6).toFixed(2)} MJ/kg`;
  }
  const fmtDv = ms => (!Number.isFinite(ms)) ? '—' : `${fmtInt(ms)} m/s`;
  const fmtDeg = d => (!Number.isFinite(d)) ? '—' : `${d.toFixed(1)}°`;

  // ---------- target state: one active target, clearable, no stale values ----------
  function setTarget(id) {
    if (id && !isTargetable(id)) return false;
    if (id === target) return true;
    target = id || null;
    predToken++; dirty = true; planDirty = true; // target drives approach: re-solve plan
    return true;
  }
  function clearTarget() { return setTarget(null); }
  function getTarget() { return target; }

  // ---------- update loop: cheap every frame, heavy under invalidation ----------
  let lastR = null, lastT = 0, heavy = null, transfer = null, transferKey = '';
  const now = () => (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();

  function recompute() {
    const token = predToken;
    const simNow = +ctx.getDate();
    // Manual (non-auto) burn just ended: trajectory changed, re-solve the plan once.
    const thr = ctx.flight ? ctx.flight.s.throttle : 0;
    if (lastNavThrottle > 0 && !(thr > 0) && nodes.length) planDirty = true;
    lastNavThrottle = thr;
    // Solve the frozen plan only on edits (cadence-limited here), never per-frame.
    if ((planDirty || (nodes.length && !cachedPlan)) && !(thr > 0)) { buildPlan(); planDirty = false; }
    if (!nodes.length) { cachedPlan = null; planDirty = false; }

    const result = buildPreview();
    if (token !== predToken) return;
    heavy = result;
    dirty = false;
    lastHeavy = now();
    lastR = { x: ctx.flight.s.r.x, y: ctx.flight.s.r.y, z: ctx.flight.s.r.z || 0 };
    lastT = simNow;
    const key = `${target}|${result.refId}`;
    if (key !== transferKey) { transferKey = key; transfer = target ? getTransferEstimate(result.refId, target) : null; }
  }
  function tick() {
    if (!ctx) return null;
    const craft = ctx.flight.s;
    if (dirty) {
      recompute();
    } else {
      const elapsed = now() - lastHeavy;
      const cadence = editing ? EDIT_MS : RECOMPUTE_MS;
      const craftMoved = !lastR || len(sub(craft.r, lastR)) > 500;
      const timeMoved = Math.abs(+ctx.getDate() - lastT) > 250;
      if (elapsed >= cadence && (craftMoved || timeMoved)) recompute();
    }
    snapshot = buildSnapshot(currentRefId());
    return snapshot;
  }
  function buildSnapshot(refId = currentRefId()) {
    const craft = ctx.flight.s;
    const els = getOrbitalElements(craft, refId);
    const rel = target ? getRelativeState(craft, target) : null;
    const approach = heavy ? (heavy.plan ? heavy.plan.approach : heavy.base ? heavy.base.approach : null) : null;
    return {
      refId, refName: bodyName(refId),
      targetId: target, targetName: target ? bodyName(target) : null,
      soiRadius: soiRadius(refId),
      targetSoiRadius: target ? soiRadius(target) : null,
      live: rel ? { distance: rel.distance, altitude: rel.altitude, radial: rel.radial, closing: rel.closing, speedRel: rel.speedRel } : null,
      elements: els,
      approach: approach ? {
        distance: approach.distance, tSec: approach.tSec, relSpeed: approach.relSpeed,
        radial: approach.radial, atHorizon: !!approach.atHorizon,
        truncated: !!approach.truncated, point: approach.point
      } : null,
      heavy,
      dvTotal: heavy && heavy.plan ? heavy.plan.dvTotal : 0,
      transfer,
      nodes: nodes.map(n => ({ id: n.id, t: nodeRemaining(n), referenceBody: n.referenceBody, progradeDv: n.progradeDv, radialDv: n.radialDv, normalDv: n.normalDv, totalDv: n.totalDv })),
      token: predToken,
      predToken
    };
  }

  // ---------- lifecycle ----------
  function init(options) {
    ctx = {
      catalog: options.catalog, constants: options.constants, flight: options.flight,
      getBodies: options.getBodies, getDate: options.getDate, getRefId: options.getRefId
    };
    target = null; nodes = []; seq = 0;
    predToken++; dirty = true;
    cachedPlan = null; planDirty = true; lastNavThrottle = 0;
    heavy = null; transfer = null; transferKey = ''; lastR = null; lastT = 0; snapshot = null;
  }
  function invalidate() { dirty = true; }
  function onReset() { clearNodes(); planDirty = true; }   // new campaign: plans are meaningless after relaunch
  function getSnapshot() { return snapshot; }
  // Public prediction entry for an arbitrary state (spec PART 2 name).
  function propagatePreview(state, opts = {}) {
    const tStart = opts.tSec || 0;
    const horizon = opts.horizon || pickHorizon(tStart, state, opts.refId || currentRefId());
    return propagateLeg(state, tStart, horizon, opts.trackTarget !== false && !!target);
  }

  return {
    init, invalidate, onReset, tick, getSnapshot,
    setTarget, clearTarget, getTarget, isTargetable, bodyName,
    getRelativeState, getOrbitalElements, getClosestApproach,
    predictTrajectory, propagatePreview, calculateBurn, applyBurnToPreview,
    getVelocityFrame, getTransferEstimate, createManeuverNode,
    addNode, updateNode, removeNode, clearNodes, getNodes, setEditing,
    prepareExecution, commitExecution, currentRefId, soiRadius,
    fmtDistance, fmtSpeed, fmtSignedSpeed, fmtDur, fmtEcc, fmtApo, fmtPeri,
    fmtEnergy, fmtDv, fmtDeg,
    buildGrid, gridAt, gravityAcc, propagateLeg,
    closestApproachIn, buildPreview, buildSnapshot,
    // Deliberate test seams; production code uses only the public API above.
    _internals: { worldAt, velocityAt, selectBodies, buildGrid, propagateLeg, hohmann, sampleAt, len, sub, dot, cross, unit, copyState, buildPreview }
  };
})();
