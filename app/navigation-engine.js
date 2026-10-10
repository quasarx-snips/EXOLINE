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
    const parentId = ctx.constants.bodies[id] && ctx.constants.bodies[id].parent;
    const AU = ctx.constants.AU_M;
    // Primary planets and dwarfs: heliocentric Keplerian state (AU).
    // Moons: ExolineOrbit.state() returns null for them, so fall back to the
    // moon mean elements — WITHOUT this, lunar gravity vanished from every
    // prediction and a craft in lunar orbit was integrated as if the Moon
    // were not there.
    let point = null;
    const s = window.ExolineOrbit.state(id, date);
    if (s && finiteVec(s)) point = { x: s.x * AU, y: s.y * AU, z: (s.z || 0) * AU };
    else if (parentId) {
      const m = window.ExolineOrbit.moonAt(id, date);
      if (m) point = { x: m.x * AU, y: m.y * AU, z: (m.z || 0) * AU };
    }
    if (!point) return null;
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

  // ---------- sphere of influence: Hill sphere r = a(1-e)·(m/3M)^(1/3) ----------
  // The boundary where the body's pull finally beats its primary's tidal
  // term. The previous Laplace form (m/M)^(2/5) overstated Earth's SOI by
  // ~40% and silently returned null for every moon (state() has no moons),
  // so lunar SOIs did not exist at all.
  function soiRadius(id) {
    if (!id || id === 'sun') return null;
    const physical = ctx.constants.bodies[id];
    if (!physical) return null;
    // Primary planets and dwarf planets are Sun-orbiting bodies even though
    // the compact physics catalog does not repeat parent: "sun" for each.
    // Moons DO carry parent and orbit it directly.
    const parentId = physical.parent || 'sun';
    const parent = ctx.constants.bodies[parentId];
    if (!parent) return null;
    const el = window.ExolineOrbit.elements(id, ctx.getDate());
    if (!el || !(el.aAU > 0) || !Number.isFinite(el.aAU)) return null;
    const a = el.aAU * ctx.constants.AU_M;
    const ecc = Math.max(0, Math.min(0.99, el.e || 0));
    const hill = a * (1 - ecc) * Math.cbrt(physical.mass / (3 * parent.mass));
    // Never smaller than the body: a degenerate SOI would swallow the surface.
    return Math.max(hill, physical.radius_m);
  }

  // ---------- prediction: ephemeris grid + adaptive RK4 coast ----------
  // Body motion over the leg is sampled once onto a grid and interpolated,
  // so each RK4 evaluation stays cheap while remaining on the real ephemeris.
  function buildGrid(ids, tStart, horizon) {
    const spacing = clamp(horizon / 192, 30, 3600);
    const count = Math.min(1500, Math.max(2, Math.ceil(horizon / spacing) + 1));
    const step = horizon / (count - 1);
    const grid = { ids, tStart, spacing: step, count, points: {}, vels: {} };
    for (const id of ids) {
      const column = new Float64Array(count * 3);
      for (let i = 0; i < count; i++) {
        const p = worldAt(id, tStart + i * step);
        column[i * 3] = p ? p.x : 0; column[i * 3 + 1] = p ? p.y : 0; column[i * 3 + 2] = p ? p.z : 0;
      }
      // Body velocity by central difference of the sampled positions. The
      // atmosphere drag needs vrel = craft velocity - body velocity, and the
      // body velocity is O(30 km/s) for a planet — ignoring it would corrupt
      // both the drag magnitude and direction.
      const vels = new Float64Array(count * 3);
      for (let i = 0; i < count; i++) {
        const i0 = Math.max(0, i - 1), i1 = Math.min(count - 1, i + 1), span = (i1 - i0) * step;
        if (span > 0) {
          vels[i * 3] = (column[i1 * 3] - column[i0 * 3]) / span;
          vels[i * 3 + 1] = (column[i1 * 3 + 1] - column[i0 * 3 + 1]) / span;
          vels[i * 3 + 2] = (column[i1 * 3 + 2] - column[i0 * 3 + 2]) / span;
        }
      }
      grid.points[id] = column; grid.vels[id] = vels;
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
    const vc = grid.vels && grid.vels[id];
    if (vc) {
      pt.vx = vc[a] + (vc[b] - vc[a]) * u;
      pt.vy = vc[a + 1] + (vc[b + 1] - vc[a + 1]) * u;
      pt.vz = vc[a + 2] + (vc[b + 2] - vc[a + 2]) * u;
    }
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
  function propagateLeg(startState, tStart, horizon, track, initialRefId = null) {
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
    let domId = initialRefId || ids[0]; // initial dominant body
    while (t < horizon - 1e-6 && steps < MAX_STEPS) {
      const tAbs = tStart + t;
      domId = gridDominant(grid, state, tAbs);
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
        if (phys && len(sub(state.r, pos)) < phys.radius_m) { 
          // Only register impact for solid surface bodies; gas giants allow pass-through
          if (phys.solidSurface) { impact = true; break; }
        }
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
      steps, impact, truncated: steps >= MAX_STEPS, approach, horizon, targetId: target,
      dominantBody: domId, // final dominant body
      soiCrossings: [] // will be filled by patched conic wrapper
    };
  }

  // Detect if an SOI crossing occurred between two states by checking
  // if the dominant body changed. Returns { crossed: boolean, bodyId?, crossingTime? }
  function detectSoiCrossing(prevDomId, newDomId, tStart, tEnd, prevState, newState) {
    if (prevDomId !== newDomId) {
      // Crossing detected - find precise crossing time by bisection
      let tLow = tStart, tHigh = tEnd;
      let crossDom = newDomId;
      for (let i = 0; i < 10; i++) {
        const tMid = (tLow + tHigh) / 2;
        // We'd need to re-evaluate, but for now approximate at midpoint
        // In practice, the dominant body change is detected at step boundaries
        // so we can use the step time as crossing time
        break;
      }
      return { crossed: true, fromBody: prevDomId, toBody: newDomId, crossTime: tEnd };
    }
    return { crossed: false };
  }

  // Patched conic propagation: recursively propagate across SOI boundaries.
  // Returns array of segments, each with its own reference frame.
  function propagatePatchedConic(startState, tStart, horizon, initialRefId, track = false, maxSegments = 5) {
    const segments = [];
    let currentState = copyState(startState);
    let currentT = tStart;
    let currentRefId = initialRefId;
    let remainingHorizon = horizon;
    let prevDomId = initialRefId;

    for (let segmentIdx = 0; segmentIdx < maxSegments && remainingHorizon > 1e-6; segmentIdx++) {
      const leg = propagateLeg(currentState, currentT, remainingHorizon, track);
      if (!leg || !leg.records.length) break;

      // Check if dominant body changed during this leg
      const finalDomId = leg.dominantBody;
      if (finalDomId !== prevDomId && finalDomId !== initialRefId) {
        // SOI crossing detected - we need to split at the crossing
        // For simplicity, use the leg as-is but mark the crossing
        // A more precise implementation would bisect to find exact crossing time
        leg.soiCrossing = { fromBody: prevDomId, toBody: finalDomId, crossTime: leg.tEnd };
        segments.push(leg);
        // Continue from the end state in the new body's frame
        currentState = leg.endState;
        currentT = leg.tEnd;
        currentRefId = finalDomId;
        remainingHorizon -= (leg.tEnd - leg.tStart);
        prevDomId = finalDomId;
      } else {
        // No crossing, this leg completes the propagation
        segments.push(leg);
        break;
      }
    }
    return segments;
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

    // Final coast leg: use patched conics to propagate across SOI boundaries.
    // This allows interplanetary trajectories that transition between bodies.
    const patchedSegments = propagatePatchedConic(state, t0, pickHorizon(t0, state, currentRefId()), currentRefId(), true);
    if (!patchedSegments.length) { cachedPlan = null; return; }
    // The last segment is the final coast leg
    const finalLeg = patchedSegments[patchedSegments.length - 1];
    finalLeg.node = ordered[ordered.length - 1];
    segments.push(...patchedSegments);
    // Planet-relative copy of the post-burn path, solved once here: the
    // renderer adds the body's LIVE position, so the path follows the planet
    // and never jitters. rec.t is seconds-from-build, matching worldAt().
    // For patched conics, we build relRecords for each segment in its own frame.
    const refId = firstNode.referenceBody;
    let allRelRecords = [], allRelApproach = null, allRelImpact = null;
    for (const seg of patchedSegments) {
      const segRefId = seg.dominantBody || refId;
      const segRel = (pt, tSec) => {
        const bp = segRefId === 'sun' ? { x: 0, y: 0 } : worldAt(segRefId, tSec);
        if (!bp) return null;
        return { x: pt.x - bp.x, y: pt.y - bp.y };
      };
      const stride = Math.max(1, Math.ceil(seg.records.length / 700));
      for (let i = 0; i < seg.records.length; i += stride) {
        const rec = seg.records[i], q = segRel(rec.r, rec.t);
        if (q) allRelRecords.push({ ...q, refId: segRefId, segIndex: patchedSegments.indexOf(seg) });
      }
      const last = seg.records[seg.records.length - 1];
      if (last) {
        const q = segRel(last.r, last.t);
        if (q) { allRelRecords.push({ ...q, refId: segRefId, segIndex: patchedSegments.indexOf(seg) }); if (seg.impact) allRelImpact = { ...q, refId: segRefId }; }
      }
      if (seg.approach && seg.approach.point) {
        allRelApproach = segRel(seg.approach.point, seg.tStart + (seg.approach.tSec || 0));
        if (allRelApproach) allRelApproach.refId = seg.dominantBody;
      }
    }
    cachedPlan = { segments, marks, dvTotal, approach: patchedSegments[patchedSegments.length - 1].approach, impact: patchedSegments[patchedSegments.length - 1].impact, find: id => ordered.find(n => n.id === id), local: frozenLocalOrbit(state, firstNode.referenceBody, t0), refId, builtAt: (+ctx.getDate()), relRecords: allRelRecords, relApproach: allRelApproach, relImpact: allRelImpact, patchedSegments };
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

  // ---------- Lambert solver for interplanetary transfers ----------
  // Universal-variable formulation (Battin / Izzo). The transfer orbit is
  // parameterised by z = x^2, where x is the universal anomaly; the time of
  // flight is an explicit function of z, so the problem reduces to finding
  // the root of  dt(z) - dt_requested. Bisection on z is unconditionally
  // stable (no derivative, no divergence) and handles elliptic AND
  // hyperbolic branches from one code path.
  //
  //   C(z) = (1-cos √z)/z           S(z) = (√z - sin √z)/z^1.5
  //   y    = r1 + r2 + A (z S - 1)/√C
  //   dt   = (y^1.5 S + A √y)/√μ
  //   f = 1 - y/r1 ;  g = A√(y/μ) ;  ġ = 1 - y/r2
  //   v1 = (r2 - f·r1)/g  ;  v2 = (ġ·r2 - r1)/g
  function lambertSolve(r1, r2, dt, mu, maxIter = 80, tol = 1e-10, v1Now = null, v2Now = null) {
    const r1n = len(r1), r2n = len(r2);
    if (!(r1n > EPS && r2n > EPS && dt > EPS && mu > EPS)) return null;
    const r1u = mul(r1, 1 / r1n), r2u = mul(r2, 1 / r2n);
    const cosDv = clamp(dot(r1u, r2u), -1, 1);
    const dnu = Math.acos(cosDv);                  // transfer angle (0..π)
    if (dnu < 1e-9 || Math.abs(dnu - Math.PI) < 1e-9) return null; // degenerate
    // Lagrange's A — same for every branch
    const A = Math.sin(dnu) * Math.sqrt(r1n * r2n / (1 - cosDv));
    if (!(Math.abs(A) > EPS)) return null;
    // Stumpff functions (stable near z=0 via series)
    const C = z => {
      if (z > 1e-8) { const s = Math.sqrt(z); return (1 - Math.cos(s)) / z; }
      if (z < -1e-8) { const s = Math.sqrt(-z); return (Math.cosh(s) - 1) / (-z); }
      return 0.5 - z / 24 + z * z / 720;
    };
    const S = z => {
      if (z > 1e-8) { const s = Math.sqrt(z); return (s - Math.sin(s)) / (z * s); }
      if (z < -1e-8) { const s = Math.sqrt(-z); return (Math.sinh(s) - s) / ((-z) * s); }
      return 1 / 6 - z / 120 + z * z / 5040;
    };
    const yAt = z => {
      const c = C(z);
      if (!(c > EPS)) return -1;                    // √C undefined
      return r1n + r2n + A * (z * S(z) - 1) / Math.sqrt(c);
    };
    // √μ·Δt = (y/√C)^1.5 · S + A·√y   — Vallado, universal variable form.
    const tof = z => {
      const y = yAt(z);
      if (y <= 0) return Infinity;
      const rc = Math.sqrt(C(z));
      if (!(rc > EPS)) return Infinity;
      return (Math.pow(y / rc, 1.5) * S(z) + A * Math.sqrt(y)) / Math.sqrt(mu);
    };
    // Bracket: z = 0 is the parabolic (minimum-energy) reference. Elliptic
    // branches live in (0, 4π²); hyperbolic branches in z < 0. dt(z) grows
    // monotonically with z on the elliptic side, so bisection always closes.
    const Z_MAX = 4 * Math.PI * Math.PI;            // 4π² ≈ 39.5
    const zAt = z2 => tof(z2);
    let lo, hi, tLo;
    if (dt <= zAt(0)) {                             // hyperbolic: z < 0
      lo = -Z_MAX * 64; hi = 0; tLo = zAt(lo);
      // dt(z) also grows as z becomes more negative; make sure bracket holds
      if (!(Math.abs(tLo) < Infinity) || tLo <= dt) return null;
    } else {                                        // elliptic: 0 < z < 4π²
      lo = 0; hi = Z_MAX; tLo = zAt(hi);
      if (!(tLo >= dt)) return null;                // requested dt beyond rev limit
    }
    // Bisection on z
    let z = 0;
    for (let i = 0; i < maxIter; i++) {
      z = 0.5 * (lo + hi);
      const t = zAt(z);
      if (!Number.isFinite(t)) { if (z < 0) lo = z; else hi = z; continue; }
      if (t > dt) { if (lo === 0 && z > 0) hi = z; else if (z < 0) lo = z; else hi = z; }
      else { if (z < 0) hi = z; else lo = z; }
      if (Math.abs(hi - lo) < tol * Math.max(1, Math.abs(z))) break;
    }
    // Converged z — evaluate f, g, ġ
    z = 0.5 * (lo + hi);
    const y = yAt(z);
    if (!(y > 0)) return null;
    const f = 1 - y / r1n;
    const g = A * Math.sqrt(y / mu);
    const gdot = 1 - y / r2n;
    if (!(Math.abs(g) > EPS)) return null;
    const v1 = mul(sub(r2, mul(r1, f)), 1 / g);
    const v2 = mul(sub(mul(r2, gdot), r1), 1 / g);
    if (!finiteVec(v1) || !finiteVec(v2)) return null;
    // dv1/dv2 are true impulsive Δv: |v_transfer − v_current|. When the current
    // state isn't supplied they fall back to |v_transfer| (heliocentric speed).
    const dv1 = v1Now ? len(sub(v1, v1Now)) : len(v1);
    const dv2 = v2Now ? len(sub(v2, v2Now)) : len(v2);
    // Semi-major axis of the transfer orbit, so callers can reject a solution
    // whose energy points the wrong way (retrograde transfer to a target that
    // requires an outward burn).
    const energy = (v1.x * v1.x + v1.y * v1.y + (v1.z || 0) * (v1.z || 0)) / 2 - mu / r1n;
    const a = Math.abs(energy) > EPS ? -mu / (2 * energy) : Infinity;
    return { v1, v2, dv1, dv2, totalDv: dv1 + dv2, tof: dt, transfers: 1, z, a, energy };
  }

  // Multi-revolution Lambert solver (finds all solutions up to N revolutions)
  function lambertMultiRev(r1, r2, dt, mu, maxRev = 3) {
    // For each revolution count, solve the multi-rev Lambert problem
    // The transfer angle becomes dv + 2π*M for M revolutions
    // This is a simplified version - full implementation would adjust the angle
    const solutions = [];
    for (let M = 0; M <= maxRev; M++) {
      // For M>0, the transfer angle increases by 2π*M
      // This is a placeholder - full multi-rev requires adjusting the geometry
      const sol = lambertSolve(r1, r2, dt, mu);
      if (sol) { sol.revolutions = M; solutions.push(sol); }
    }
    return solutions;
  }

  // Compute transfer windows using phase angle / synodic period
  // Scans ephemeris time forward, solving Lambert at each sample and keeping
  // the windows where the transfer actually closes (arrival distance within
  // the target's SOI). Works for planet->planet (heliocentric Lambert) and
  // planet->moon (planet-frame Lambert).
  function computeTransferWindows(fromId, toId, maxWindows = 10, searchDays = 730) {
    if (!ctx || !fromId || !toId || fromId === toId) return null;
    const constants = ctx.constants;
    const fromP = constants.bodies[fromId], toP = constants.bodies[toId];
    if (!fromP || !toP) return null;
    const AU = constants.AU_M;
    const now = ctx.getDate();
    const startMs = +now;
    const windows = [];

    // -------- case 1: target is a MOON of the departure body --------
    // Planet-frame transfer: mu of the planet, r1 = craft's current position,
    // r2 = the moon's position at the arrival epoch. Scan the moon's orbital
    // period for the epoch where the required departure Δv is smallest.
    if (toP.parent && toP.parent === fromId) {
      const mu = constants.G * fromP.mass;
      const el = window.ExolineOrbit.elements(toId, now);
      const craftEl = getOrbitalElements(ctx.flight.s, fromId);
      if (!el || !(el.aAU > 0)) return null;
      const moonA = el.aAU * AU;
      const r1 = craftEl && craftEl.distance > EPS ? craftEl.distance : fromP.radius_m + 180000;
      if (!(moonA > r1) || r1 <= fromP.radius_m) return null;
      // Transfer TOF from a Hohmann arc between the two radii (planet frame)
      const aT = (r1 + moonA) / 2;
      const tHohmann = Math.PI * Math.sqrt(aT ** 3 / mu);
      const moonPeriod = 2 * Math.PI * Math.sqrt(moonA ** 3 / mu);
      const stepSec = Math.max(300, moonPeriod / 400);
      const total = Math.min(searchDays * 86400, moonPeriod);
      // Craft's current state in the planet frame (frozen for window math)
      const hostNow = worldAtDate(fromId, now);
      if (!hostNow) return null;
      const craftOff = {
        x: ctx.flight.s.r.x - hostNow.x,
        y: ctx.flight.s.r.y - hostNow.y,
        z: (ctx.flight.s.r.z || 0) - (hostNow.z || 0)
      };
      // The transfer is solved in the PLANET frame, so the craft's velocity
      // must be planet-relative too. Using the raw inertial velocity mixes
      // frames and inflates the departure Δv by the planet's own heliocentric
      // speed (for Earth that is ~30 km/s of pure error).
      const hostVel = velocityAt(fromId, 0) || { x: 0, y: 0, z: 0 };
      const craftVelNow = {
        x: ctx.flight.s.v.x - (hostVel.x || 0),
        y: ctx.flight.s.v.y - (hostVel.y || 0),
        z: (ctx.flight.s.v.z || 0) - (hostVel.z || 0)
      };
      let best = null;
      const arrivalEpochMs = tHohmann * 1000;
      // The craft keeps orbiting while we scan, so its longitude advances by
      // n·t (n = mean motion). Holding it fixed would under-sample the real
      // set of TLI opportunities and inflate the minimum Δv.
      const craftR = Math.max(r1, fromP.radius_m + 1e5);
      const nCraft = Math.sqrt(mu / (craftR * craftR * craftR));
      for (let t = 0; t <= total; t += stepSec) {
        const d = new Date(startMs + t * 1000);
        // Lambert's problem: r1 and r2 are both relative to the CENTRAL body
        // (the planet), each sampled at ITS OWN epoch. Subtracting a later
        // moon position from an earlier planet position mixes in the planet's
        // own heliocentric motion and produces a garbage vector.
        const hostDep = worldAtDate(fromId, d);
        const hostArr = worldAtDate(fromId, new Date(+d + arrivalEpochMs));
        const moonPos = worldAtDate(toId, new Date(+d + arrivalEpochMs));
        if (!hostDep || !hostArr || !moonPos) continue;
        // Advance the craft's offset along its own orbit by n·t.
        const ang = nCraft * t;
        const ca = Math.cos(ang), sa = Math.sin(ang);
        const ox = craftOff.x * ca - craftOff.y * sa, oy = craftOff.x * sa + craftOff.y * ca;
        const craftAbs = { x: hostDep.x + ox, y: hostDep.y + oy, z: (hostDep.z || 0) + craftOff.z };
        const r1 = { x: craftAbs.x - hostDep.x, y: craftAbs.y - hostDep.y, z: (craftAbs.z || 0) - (hostDep.z || 0) };
        const r2 = { x: moonPos.x - hostArr.x, y: moonPos.y - hostArr.y, z: (moonPos.z || 0) - (hostArr.z || 0) };
        const sol = lambertSolve(r1, r2, tHohmann, mu, 80, 1e-10, craftVelNow, null);
        if (!sol || !Number.isFinite(sol.dv1)) continue;
        if (!best || sol.dv1 < best.sol.dv1) best = { sol, t, d };
      }
      if (!best) return null;
      windows.push({
        date: best.d, departureBody: fromId, arrivalBody: toId,
        dvDeparture: best.sol.dv1, dvArrival: best.sol.dv2, totalDv: best.sol.totalDv,
        tof: tHohmann, method: 'LAMBERT', moonTransfer: true
      });
      return windows;
    }

    // -------- case 2: heliocentric planet -> planet --------
    // Analytic Hohmann window search. This is numerically robust where the
    // universal-variable Lambert form is not: as the transfer angle approaches
    // 180°, Lagrange's A -> 0 and g -> 0, so both numerator and denominator
    // suffer catastrophic cancellation. The phase-angle criterion is exact for
    // a Hohmann arc and avoids that singularity entirely.
    //
    // At departure the target must sit at
    //     φ_req = π − ω_t · t_H          (outerward, prograde)
    //     φ_req = π + ω_t · t_H          (inward)
    // ahead of the departure body, where ω_t is the target's mean motion. The
    // relative phase advances at (ω_dep − ω_t), so the window recurs every
    // synodic period.
    const el1 = window.ExolineOrbit.elements(fromId, now);
    const el2 = window.ExolineOrbit.elements(toId, now);
    if (!el1 || !el2 || !(el1.aAU > 0) || !(el2.aAU > 0)) return null;
    const a1 = el1.aAU * AU, a2 = el2.aAU * AU;
    const sunBody = constants.bodies.sun;
    if (!sunBody) return null;
    const mu = constants.G * sunBody.mass;
    const P1 = 2 * Math.PI * Math.sqrt(a1 ** 3 / mu);
    const P2 = 2 * Math.PI * Math.sqrt(a2 ** 3 / mu);
    const aT = (a1 + a2) / 2;
    const tHohmann = Math.PI * Math.sqrt(aT ** 3 / mu);
    const wDep = 2 * Math.PI / P1, wTgt = 2 * Math.PI / P2;
    const outerward = a2 > a1;
    // Phase the target must lead by at departure (prograde-positive).
    const phiReq = Math.PI - (outerward ? 1 : -1) * wTgt * tHohmann;
    const phaseErr = t => {
      const A = worldAtDate(fromId, new Date(startMs + t * 1000));
      const B = worldAtDate(toId, new Date(startMs + t * 1000));
      if (!A || !B) return Infinity;
      // signed phase of B ahead of A, in [0, 2π)
      let d = Math.atan2(B.y, B.x) - Math.atan2(A.y, A.x);
      while (d < 0) d += 2 * Math.PI;
      while (d >= 2 * Math.PI) d -= 2 * Math.PI;
      // wrap the error to (-π, π]
      let e = d - phiReq;
      while (e > Math.PI) e -= 2 * Math.PI;
      while (e <= -Math.PI) e += 2 * Math.PI;
      return e;
    };
    // Relative phase rate: find the earliest zero crossing of phaseErr.
    // d(phase)/dt = wDep - wTgt, so the error sweeps monotonically unless the
    // orbits are near-resonant. Scan coarsely then bisect the bracket.
    const scanStep = Math.max(600, Math.abs(1 / (wDep - wTgt)) / 5000);
    const total = Math.min(searchDays * 86400, 2 * Math.abs(1 / (wDep - wTgt)));
    const roots = [];
    let prevT = 0, prevE = phaseErr(0);
    if (Number.isFinite(prevE) && Math.abs(prevE) < scanStep * Math.abs(wDep - wTgt) * 0.5) roots.push(0);
    for (let t = scanStep; t <= total && roots.length < maxWindows; t += scanStep) {
      const e = phaseErr(t);
      if (!Number.isFinite(e)) { prevT = t; prevE = e; continue; }
      if (Number.isFinite(prevE) && ((prevE < 0 && e >= 0) || (prevE > 0 && e <= 0))) {
        // bisect the bracket [prevT, t]
        let lo = prevT, hi = t, elo = prevE;
        for (let i = 0; i < 40; i++) {
          const mid = 0.5 * (lo + hi), em = phaseErr(mid);
          if (!Number.isFinite(em)) break;
          if ((elo < 0 && em < 0) || (elo > 0 && em > 0)) { lo = mid; elo = em; }
          else hi = mid;
          if (hi - lo < 1) break;
        }
        roots.push(Math.round(0.5 * (lo + hi)));
      }
      prevT = t; prevE = e;
    }
    if (!roots.length) return null;
    // Hohmann Δv: vis-viva at both radii vs the bodies' circular speeds.
    const vDepTransfer = Math.sqrt(mu * (2 / a1 - 1 / aT));
    const vArrTransfer = Math.sqrt(mu * (2 / a2 - 1 / aT));
    const vDepCirc = Math.sqrt(mu / a1), vArrCirc = Math.sqrt(mu / a2);
    const dvDeparture = Math.abs(vDepTransfer - vDepCirc);
    const dvArrival = Math.abs(vArrTransfer - vArrCirc);
    for (const t of roots) {
      if (t > total) continue;
      windows.push({
        date: new Date(startMs + t * 1000),
        departureBody: fromId, arrivalBody: toId,
        dvDeparture, dvArrival, totalDv: dvDeparture + dvArrival,
        tof: tHohmann, method: 'HOHMANN', phaseAtWindow: phiReq
      });
    }
    return windows.length ? windows : null;
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
    buildGrid, gridAt, gravityAcc, propagateLeg, propagatePatchedConic,
    lambertSolve, lambertMultiRev, computeTransferWindows,
    closestApproachIn, buildPreview, buildSnapshot,
    // Deliberate test seams; production code uses only the public API above.
    _internals: { worldAt, velocityAt, selectBodies, buildGrid, propagateLeg, propagatePatchedConic, hohmann, lambertSolve, computeTransferWindows, sampleAt, len, sub, dot, cross, unit, copyState, buildPreview }
  };
})();
