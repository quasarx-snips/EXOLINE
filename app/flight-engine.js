window.ExolineFlight = (() => {
  const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: (a.z || 0) + (b.z || 0) });
  const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: (a.z || 0) - (b.z || 0) });
  const mul = (a, n) => ({ x: a.x * n, y: a.y * n, z: (a.z || 0) * n });
  const dot = (a, b) => a.x * b.x + a.y * b.y + (a.z || 0) * (b.z || 0);
  const length = a => Math.sqrt(dot(a, a));
  // One RK4 step for a second-order system. Shared by the live integrator and
  // the navigation preview so both use the exact same numerical scheme.
  function rk4Step(state, dt, acceleration) {
    const k1r = state.v, k1v = acceleration(state.r, 0, state.v);
    const k2r = add(state.v, mul(k1v, dt / 2)), k2v = acceleration(add(state.r, mul(k1r, dt / 2)), dt / 2, k2r);
    const k3r = add(state.v, mul(k2v, dt / 2)), k3v = acceleration(add(state.r, mul(k2r, dt / 2)), dt / 2, k3r);
    const k4r = add(state.v, mul(k3v, dt)), k4v = acceleration(add(state.r, mul(k3r, dt)), dt, k4r);
    state.r = add(state.r, mul(add(add(k1r, mul(k2r, 2)), add(mul(k3r, 2), k4r)), dt / 6));
    state.v = add(state.v, mul(add(add(k1v, mul(k2v, 2)), add(mul(k3v, 2), k4v)), dt / 6));
  }

  const ATMOSPHERES = {
    // { surfaceDensity kg/m3, scaleHeight m, top m, solidSurface bool }
    // Density model: rho(h) = surfaceDensity * exp(-h/scaleHeight) for 0 <= h <= top, else 0
    // Drag acceleration = 0.5 * rho * |vrel|^2 * Cd * A / m, opposite vrel
    // Cd = 0.60, A = 10.0 m2
    earth:   { surfaceDensity: 1.225,  scaleHeight: 8500,   top: 100000,  solidSurface: true  },
    venus:   { surfaceDensity: 65.0,    scaleHeight: 15900,  top: 250000, solidSurface: true  },
    mars:    { surfaceDensity: 0.020,   scaleHeight: 11100,  top: 120000, solidSurface: true  },
    'saturn:titan': { surfaceDensity: 5.40, scaleHeight: 20700, top: 200000, solidSurface: true },
    jupiter: { surfaceDensity: 0.16,    scaleHeight: 27000,  top: 1000000, solidSurface: false },
    saturn:  { surfaceDensity: 0.19,    scaleHeight: 59500,  top: 1000000, solidSurface: false },
    uranus:  { surfaceDensity: 0.42,    scaleHeight: 27700,  top: 1000000, solidSurface: false },
    neptune: { surfaceDensity: 0.45,    scaleHeight: 19700,  top: 1000000, solidSurface: false },
  };
  const DRAG_CD = 0.60;
  const DRAG_AREA = 10.0;
  // v0.1.2 thermal + parachute constants. Ambient skin temperature (K),
  // OVERHEAT flash threshold, irreversible damage threshold, hard display
  // cap, convective cooling time constant, and heat-shield half-angle (20 deg
  // = 0.349 rad). Heating follows the reentry steady state
  // heatRate = K_HEAT * sqrt(rho) * vrel^3, shielded at 25% when the nose
  // sits within SHIELD_HALF of the relative wind; the craft relaxes toward
  // ambient with tau = COOL_TAU s once the flux drops.
  const AMBIENT_K = 290;
  const K_HEAT = 2.5e-7;
  const OVERHEAT_K = 1500;
  const BREAKUP_K = 2500;
  const TEMP_MAX_K = 3200;
  const COOL_TAU = 2.0;
  const SHIELD_HALF = 0.349;
  const SHIELD_FACTOR = 0.25;
  const CHUTE_SPEED_LIMIT = 400;
  const CHUTE_CD = 1.5, CHUTE_AREA = 40.0;
  const DAMAGE_RATE = 0.06;
  // A body is "solid" unless its atmosphere entry says otherwise (the four
  // gas giants). This is the single source of truth for landing lines and for
  // impact termination in the predictions — the Sun is collidable and has no
  // atmosphere, so it stays solid.
  function isSolidSurface(id) {
    const atmosphere = ATMOSPHERES[id];
    return atmosphere ? atmosphere.solidSurface : true;
  }
  function atmosphereDensity(position, body, physical) {
    const atmosphere = ATMOSPHERES[physical.id];
    if (!atmosphere) return null;
    const altitude = length(sub(position, body)) - physical.radius_m;
    if (!(altitude >= 0 && altitude < atmosphere.top)) return null;
    return atmosphere.surfaceDensity * Math.exp(-altitude / atmosphere.scaleHeight);
  }
  const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value));
  // perp(v) = (-v.y, v.x) — the in-plane unit perpendicular used for lift.
  const perp2d = v => ({ x: -v.y, y: v.x, z: 0 });
  // Wrap an angle to [-PI, PI].
  function wrapAngle(a) { return Math.atan2(Math.sin(a), Math.cos(a)); }
  // aerodynamicDrag is retained for backward compatibility (physics-agent and
  // any external callers). It now accepts an optional induced drag coefficient;
  // with no override it uses the base DRAG_CD, so old behavior is unchanged.
  // Internally it is only ever called by aeroAccel (v0.1.2).
  function atmosphericDrag(position, velocity, body, physical, mass, cd = DRAG_CD) {
    const rho = atmosphereDensity(position, body, physical);
    if (!rho) return { x: 0, y: 0, z: 0 };
    const v = sub(velocity, { x: body.vx || 0, y: body.vy || 0, z: body.vz || 0 }), speed = length(v);
    if (!(speed > 0)) return { x: 0, y: 0, z: 0 };
    // Drag acceleration opposite to relative velocity vector
    return mul(v, -0.5 * rho * cd * DRAG_AREA * speed / Math.max(mass, 1));
  }
  // v0.1.2 combined aerodynamics: drag (base + induced) plus lift from AoA.
  //   AoA  = signed wrapped angle between the craft heading and vrel.
  //   Cl   = clamp(4.0 * AoA, -1.2, 1.2), halved past the 0.45 rad stall AoA.
  //   Lift = 0.5 * rho * |vrel|^2 * Cl * A / m along unit(perp(vrel))*sign(AoA).
  //   Cd   = 0.60 + 0.15 * Cl^2  (induced drag).
  // heading is the craft nose direction (radians); chuteAlive forces Cl = 0 so a
  // parachute produces pure drag with no lift. Returns {x, y, z}.
  function aeroAccel(position, velocity, body, physical, craftMass, heading, chuteAlive = false) {
    const drag = atmosphericDrag(position, velocity, body, physical, craftMass);
    const rho = atmosphereDensity(position, body, physical);
    if (!rho) return drag; // vacuum: no lift, and drag already returned as-is
    const vx = velocity.x - (body.vx || 0), vy = velocity.y - (body.vy || 0);
    const speed = Math.hypot(vx, vy);
    if (!(speed > 1e-6)) return drag;
    // Signed AoA in [-PI, PI] between heading vector and vrel.
    const hx = Math.cos(heading), hy = Math.sin(heading);
    const aoa = wrapAngle(Math.atan2(hx * vy - hy * vx, hx * vx + hy * vy));
    let cl = clamp(4.0 * aoa, -1.2, 1.2);
    if (Math.abs(aoa) > 0.45) cl *= 0.5; // stalled: lift collapses
    if (chuteAlive) cl = 0;              // parachute: no lift
    // Lift magnitude along unit(perp(vrel)) * sign(AoA).
    const liftMag = 0.5 * rho * speed * speed * cl * DRAG_AREA / Math.max(craftMass, 1);
    const sign = aoa >= 0 ? 1 : -1;
    const unitPerp = { x: -vy / speed, y: vx / speed, z: 0 };
    const lift = mul(unitPerp, liftMag * sign);
    // Induced drag replaces the base-drag-only result.
    const cd = 0.60 + 0.15 * cl * cl;
    const inducedDrag = atmosphericDrag(position, velocity, body, physical, craftMass, cd);
    return add(inducedDrag, lift);
  }
  function atmosphereStepLimit(position, velocity, bodies, constants, mass) {
    let limit = Infinity;
    for (const [id, body] of Object.entries(bodies)) {
      const physical = constants.bodies[id]; if (!physical) continue;
      const atm = ATMOSPHERES[id]; if (!atm) continue;
      // Check proximity to atmosphere top even in vacuum, to pre-limit step
      // before density becomes significant. This prevents a huge warp step
      // from jumping completely through the upper atmosphere in one go.
      const altitude = length(sub(position, body)) - physical.radius_m;
      if (altitude > atm.top * 1.5) continue; // far outside atmosphere
      const rho = atmosphereDensity(position, body, { ...physical, id });
      // Once we are inside or near the atmosphere, hard-cap the step at 5 s
      // regardless of density so the integrator always resolves the exponential
      // density gradient and avoids the "skipping stone" bounce.
      if (altitude < atm.top) {
        // Inside atmosphere: cap based on aerodynamic time-constant, minimum 0.25 s
        const speed = length(sub(velocity, { x: body.vx || 0, y: body.vy || 0, z: body.vz || 0 }));
        if (rho && rho > 1e-6 && speed > 1) {
          const decay = 0.5 * rho * DRAG_CD * DRAG_AREA * speed;
          const cap = Math.sqrt(Math.max(mass, 1) / Math.max(decay, 1e-12)) * 0.4;
          limit = Math.min(limit, Math.max(0.25, Math.min(5, cap)));
        } else {
          // Upper tenuous atmosphere: limit to 5 s so density gradient is sampled
          limit = Math.min(limit, 5);
        }
      }
    }
    return limit;
  }
  class Flight {
    constructor(constants) {
      this.c = constants;
      // Stamp the solid/gas classification onto the shared constants object so
      // the renderer and the navigation layer read the same flag. Gas giants
      // let the craft pass through; everything else is a landing surface.
      if (constants && constants.bodies) {
        for (const id of Object.keys(constants.bodies)) {
          if (typeof constants.bodies[id].solidSurface !== 'boolean') constants.bodies[id].solidSurface = isSolidSurface(id);
        }
      }
      // Staging system: array of stage definitions
      // Each stage: { id, dryMass, propellant, thrust, isp }
      this.stages = [];
      this.currentStage = 0;
      // Payload mass (constant, not dropped during staging)
      this.payloadMass = 50;
      // Ascent automation (gravity turn)
      this.ascentMode = false;
      // Engine config derived from active stage (set in updateStageProperties)
      this.thrust = 0;
      this.specificImpulse = 0;
      this.dryMass = 0;
      this.infiniteFuel = false;
      this.circularHold = null;
      this.progradeLock = true;   // powered flight tracks orbital prograde unless overridden
      this.steerOverride = false; // set by auto-burn while it owns the heading
      this.manualSteer = false;   // set by app while turn keys are held
      this.coast = null;          // analytic on-rails coast arc (patched conic), or null
      this.landedBody = null;     // body id the craft is sitting on, or null
      this.landedDir = null;      // body-relative surface direction, unit vector
      this.prevThrottle = 0;
      // v0.1.2 thermal + parachute state (persisted in s / serialize).
      //   temperature (K, ambient 290), heatDamage (0..1, never heals),
      //   chuteDeployed / chuteAlive, shieldFacing (HUD), _overheated latch.
      this.s = this.freshCraftState({ heading: 0, landed: false });
      // Reentry tracking state (per dominant body)
      this.reentryState = { bodyId: null, phase: 'EXO', q: 0, rho: 0, heating: 0, gLoad: 0, alt: 0, peakHeating: 0, peakG: 0 };
    }

    // One place that builds a zeroed craft state so every fresh start —
    // pad, gas-giant orbit, LOI/LEO preset — carries the thermal/chute
    // fields the constructor defines. opts override r/v/m/propellant/
    // heading/throttle/landed only; everything else stays at its default.
    freshCraftState(opts = {}) {
      return {
        r: opts.r || { x: 0, y: 0, z: 0 },
        v: opts.v || { x: 0, y: 0, z: 0 },
        m: opts.m || 0,
        propellant: opts.propellant || 0,
        heading: opts.heading || 0,
        throttle: opts.throttle || 0,
        crashed: false,
        landed: !!opts.landed,
        temperature: AMBIENT_K,
        heatDamage: 0,
        chuteDeployed: false,
        chuteAlive: false,
        shieldFacing: false
      };
    }

    // Update thrust, specificImpulse, dryMass, and mass from the active stage
    updateStageProperties() {
      const stage = this.stages[this.currentStage];
      if (!stage) return;
      this.thrust = stage.thrust;
      this.specificImpulse = stage.isp;
      this.dryMass = stage.dryMass;
      // Total mass = stage dryMass + stage propellant + payloadMass
      this.s.m = stage.dryMass + stage.propellant + this.payloadMass;
      this.s.propellant = stage.propellant;
    }
    launch(id, bodies) {
      // Every launch starts a FRESH vehicle: rebuild the default stage stack
      // unconditionally. The old guard (`if (!this.stages.length)`) built it
      // once per session, so relaunching from the mission screen after a
      // depleted flight kept empty tanks — and the fuel-blind TWR gate then
      // released the craft with no thrust available, dropping it straight off
      // the pad. Resuming a saved flight goes through deserialize() and never
      // calls launch().
      this.stages = [
        { id: 0, dryMass: 400, propellant: 400, thrust: 25000, isp: 290 },
        { id: 1, dryMass: 100, propellant: 100, thrust: 5000, isp: 350 }
      ];
      this.currentStage = 0;
      this.updateStageProperties();
      this.ascentMode = false;
      const body = bodies[id], physical = this.c.bodies[id];
      const atmosphere = ATMOSPHERES[id];
      this.coast = null; this.prevThrottle = 0;
      // Reset reentry state on launch
      this.reentryState = { bodyId: null, phase: 'EXO', q: 0, rho: 0, heating: 0, gLoad: 0, alt: 0, peakHeating: 0, peakG: 0 };
      // Solid bodies are impenetrable: their surface is the ground AND the
      // launchpad, so a mission always begins parked on it. Gas giants have no
      // surface, so they keep the orbital start.
      if (physical.solidSurface) {
        const radius = physical.radius_m;
        const dir = { x: 0, y: 1, z: 0 };
        // heading = atan2(dir): thrust points along (cos h, sin h) — see acc()
        // — so nose-out at this spawn point is +PI/2. The renderer agrees
        // (rotation -h + PI/2 = 0 draws the nose away from the planet).
        this.s = this.freshCraftState({ r: { x: body.x, y: body.y + radius, z: body.z || 0 }, v: { x: body.vx || 0, y: body.vy || 0, z: body.vz || 0 }, m: this.s.m, propellant: this.s.propellant, heading: Math.atan2(dir.y, dir.x), landed: true });
        this.circularHold = null;
        this.landedBody = id;
        this.landedDir = dir;
        // Same reentry state a touchdown produces, so the HUD reads LANDED.
        this.reentryState.bodyId = id;
        this.reentryState.phase = 'LANDED';
        this.reentryState.alt = 0;
        console.info(`[launch] ${id} surface is the launchpad; craft parked at altitude 0 (radius ${radius} m)`);
        return;
      }
      // Start above the air where there is one (plus a lift margin), else well
      // clear of the ground. Sets the circular-hold radius directly.
      const radius = physical.radius_m + (atmosphere ? atmosphere.top + 20000 : 180000);
      const speed = Math.sqrt(this.c.G * physical.mass / radius);
      this.s = this.freshCraftState({ r: { x: body.x, y: body.y + radius, z: body.z || 0 }, v: { x: body.vx - speed, y: body.vy, z: body.vz || 0 }, m: this.s.m, propellant: this.s.propellant, heading: Math.PI, landed: false });
      this.circularHold = { id, radius, phase: Math.PI / 2, meanMotion: speed / radius };
      this.landedBody = null; this.landedDir = null;
    }
    // Orbital-insertion launch preset (mission-screen "LOI"): start the fresh
    // vehicle in a CIRCULAR orbit `altitudeMeters` above `id`'s surface instead
    // of on the pad. Mirrors launch()'s orbital branch exactly — same on-rails
    // circularHold contract (phase PI/2 matches the +y spawn point, velocity
    // tangent), so the hold is numerically exact until the player thrusts.
    launchOrbit(id, bodies, altitudeMeters) {
      this.launch(id, bodies); // fresh stage stack, ascent/reentry reset
      const body = bodies[id], physical = this.c.bodies[id];
      if (!body || !physical) return; // launch() already placed a valid state
      const radius = physical.radius_m + Math.max(0, altitudeMeters);
      const speed = Math.sqrt(this.c.G * physical.mass / radius);
      this.s = this.freshCraftState({ r: { x: body.x, y: body.y + radius, z: body.z || 0 }, v: { x: body.vx - speed, y: body.vy, z: body.vz || 0 }, m: this.s.m, propellant: this.s.propellant, heading: Math.PI, landed: false });
      this.circularHold = { id, radius, phase: Math.PI / 2, meanMotion: speed / radius };
      this.landedBody = null;
      this.landedDir = null;
      this.reentryState = { bodyId: null, phase: 'EXO', q: 0, rho: 0, heating: 0, gLoad: 0, alt: 0, peakHeating: 0, peakG: 0 };
      console.info(`[launch] ${id} orbital insertion: ${Math.round(altitudeMeters / 1000)} km circular, radius=${radius} m, speed=${speed.toFixed(1)} m/s`);
    }

    // Staging: drop the previous stage's dry mass and remaining propellant.
    // updateStageProperties() rebuilds s.m from the NEW active stage plus the
    // retained payload, so mass falls instantly while velocity (momentum
    // direction) is untouched — both in flight and while pinned on the surface.
    stage() {
      if (this.currentStage >= this.stages.length - 1) {
        console.info('[stage] No more stages');
        return false;
      }
      const prevStage = this.stages[this.currentStage];
      const deadMass = prevStage.dryMass + prevStage.propellant;
      this.currentStage++;
      this.updateStageProperties();
      console.info(`[stage] Stage separation: dropped ${deadMass} kg, now stage ${this.currentStage} (thrust=${this.thrust} N, isp=${this.specificImpulse} s, mass=${this.s.m} kg)`);
      return true;
    }
    // v0.1.2 parachute. Toggle-deploy from UI (P / CHUTE). Gates per spec:
    //   — needs live bodies to read atmosphere + airspeed; without them noop.
    //   — jettisons if a live chute is already flying (toggle), reports a
    //     shredded chute as already lost, refuses vacuum with an inert note.
    //   — inside air: airspeed < 400 m/s deploys intact; >= 400 shreds it
    //     (chuteAlive=false, no extra drag — see acc/aeroAccel).
    deployChute(bodies) {
      if (!bodies || this.s.crashed) return 'CRAFT LOST';
      if (this.s.chuteDeployed && this.s.chuteAlive) {
        this.s.chuteDeployed = false;
        this.s.chuteAlive = false;
        console.info('[chute] jettisoned');
        return 'CHUTE JETTISONED';
      }
      if (this.s.chuteDeployed) return 'CHUTE ALREADY LOST';
      const refId = this.referenceBody(bodies, this.s);
      const body = refId && bodies[refId], physical = refId && this.c.bodies[refId];
      if (!body || !physical) return 'CHUTE INERT';
      const rho = atmosphereDensity(this.s.r, { x: body.x, y: body.y, z: body.z || 0 }, { ...physical, id: refId }) || 0;
      if (!(rho > 0)) { console.info('[chute] no atmosphere — deploy refused'); return 'NO ATMOSPHERE — CHUTE INERT'; }
      const vRel = sub(this.s.v, { x: body.vx || 0, y: body.vy || 0, z: body.vz || 0 });
      const airspeed = length(vRel);
      this.s.chuteDeployed = true;
      if (airspeed >= CHUTE_SPEED_LIMIT) {
        this.s.chuteAlive = false;
        console.info(`[chute] deployed at ${airspeed.toFixed(0)} m/s — SHREDDED (limit ${CHUTE_SPEED_LIMIT} m/s)`);
        return 'CHUTE LOST — DEPLOYED TOO FAST';
      }
      this.s.chuteAlive = true;
      console.info(`[chute] deployed at ${airspeed.toFixed(0)} m/s`);
      return 'CHUTE DEPLOYED';
    }
    // v0.1.2 thermal integration for one substep of dt seconds, driven by the
    // reference-body air density rho and the relative-wind vector (vx, vy).
    //   — heatRate = K_HEAT * sqrt(rho) * vrel^3 (steady reentry scaling),
    //     cut to SHIELD_FACTOR (25%) while the nose faces the wind within
    //     SHIELD_HALF (~20 deg); chute-out flight is never shielded.
    //   — temperature relaxes toward ambient with COOL_TAU, hard-capped at
    //     TEMP_MAX so a ballistic entry saturates a full bar, not Infinity.
    //   — past BREAKUP the damage counter climbs with excess temperature
    //     until 1.0, when the craft breaks up (crashed, phase BURNUP).
    thermalStep(rho, vx, vy, dt) {
      const s = this.s;
      const airspeed = Math.hypot(vx, vy);
      const facing = !(airspeed > 0) ? true : (() => {
        const wind = Math.atan2(vy, vx);              // oncoming-flow axis
        const off = Math.abs(wrapAngle(s.heading - wind));
        return !s.chuteAlive && off < SHIELD_HALF;
      })();
      s.shieldFacing = facing;
      if (!(rho > 0) || !(airspeed > 0) || !(dt > 0) || s.crashed || s.landed) return;
      const factor = facing ? SHIELD_FACTOR : 1;
      const heatRate = K_HEAT * Math.sqrt(rho) * airspeed * airspeed * airspeed * factor;
      const coolRate = (s.temperature - AMBIENT_K) / COOL_TAU;
      s.temperature = clamp(s.temperature + (heatRate - coolRate) * dt, AMBIENT_K, TEMP_MAX_K);
      if (s.temperature <= OVERHEAT_K) return;
      if (s.temperature > BREAKUP_K) {
        s.heatDamage = clamp(s.heatDamage + ((s.temperature - BREAKUP_K) / 1000) * DAMAGE_RATE * dt, 0, 1);
        if (s.heatDamage >= 1) {
          s.crashed = true;
          s.throttle = 0;
          this.reentryState.phase = 'BURNUP';
          console.warn(`[thermal] breakup at ${s.temperature.toFixed(0)} K — craft destroyed`);
        }
      }
    }
    advanceCircularHold(seconds, bodies) {
      const hold = this.circularHold, body = bodies[hold.id], physical = this.c.bodies[hold.id];
      if (!body || !physical) { this.circularHold = null; return false; }
      hold.phase += hold.meanMotion * seconds;
      const accels = this._accMap || this.bodyAccelerations(bodies);
      const host = this.bodyAt(body, seconds, accels, hold.id);
      const bv = this.bodyVelAt(body, seconds, accels, hold.id);
      const cos = Math.cos(hold.phase), sin = Math.sin(hold.phase), radius = hold.radius, speed = hold.meanMotion * radius;
      this.s.r = { x: host.x + radius * cos, y: host.y + radius * sin, z: host.z || 0 };
      this.s.v = { x: bv.x - speed * sin, y: bv.y + speed * cos, z: bv.z };
      return true;
    }
    syncCircularHold(bodies) {
      if (!this.circularHold) return;
      const hold = this.circularHold, body = bodies[hold.id]; if (!body) return;
      const cos = Math.cos(hold.phase), sin = Math.sin(hold.phase), speed = hold.meanMotion * hold.radius;
      this.s.r = { x: body.x + hold.radius * cos, y: body.y + hold.radius * sin, z: body.z || 0 };
      this.s.v = { x: (body.vx || 0) - speed * sin, y: (body.vy || 0) + speed * cos, z: body.vz || 0 };
    }
    // A landed craft rides its body the same way the circular hold does. The
    // ephemeris is re-synced AFTER step() each chunk (see the frame loop), so
    // without a matching surface sync the pinned position is read against a
    // body that has already moved: Earth sweeps ~496 m per 16 ms frame at
    // 29.78 km/s, which is exactly the false "-456 m" altitude on the pad.
    // Snapping r and v to the fresh body state keeps altitude at exactly 0
    // for every solid body, at any warp, in both the readout and the render.
    syncLanded(bodies) {
      if (!this.s.landed || this.s.crashed) return false;
      const id = this.landedBody || this.referenceBody(bodies, this.s);
      const body = bodies[id], physical = this.c.bodies[id];
      if (!body || !physical) return false;
      // Defensive: a loaded save can carry landed=true without a direction —
      // same rebuild as step()'s landed branch.
      if (!this.landedDir) {
        const rel = sub(this.s.r, body), d = length(rel);
        this.landedDir = d > 1e-6 ? { x: rel.x / d, y: rel.y / d, z: rel.z / d } : { x: 0, y: 1, z: 0 };
      }
      this.s.r = { x: body.x + this.landedDir.x * physical.radius_m, y: body.y + this.landedDir.y * physical.radius_m, z: (body.z || 0) + this.landedDir.z * physical.radius_m };
      this.s.v = { x: body.vx || 0, y: body.vy || 0, z: body.vz || 0 };
      return true;
    }
    // ---------- second-order ephemeris extrapolation ----------
    // Body positions are re-synced from the ephemeris once per chunk, so within
    // a chunk they must be extrapolated. A LINEAR extrapolation (pos + v·t) is
    // the dominant error source in the whole integrator: the reference body
    // curves along its own orbit, and over a 120 s chunk Earth sweeps ~43 m of
    // curvature that the craft never sees. That mismatch showed up as a
    // systematic apoapsis drift (-6.4 km per orbit at 1e6× warp).
    //
    // Adding the ½·a·t² term makes the extrapolation second-order accurate,
    // which removes the leading error and leaves only O(t³) residuals.
    bodyAccelerations(bodies) {
      const ids = Object.keys(bodies), out = {};
      for (const id of ids) {
        const self = bodies[id];
        let ax = 0, ay = 0, az = 0;
        for (const other of ids) {
          if (other === id) continue;
          const o = bodies[other], physical = this.c.bodies[other];
          if (!physical) continue;
          const dx = self.x - o.x, dy = self.y - o.y, dz = (self.z || 0) - (o.z || 0);
          const r2 = dx * dx + dy * dy + dz * dz;
          if (!(r2 > 1)) continue;
          const k = -this.c.G * physical.mass / (r2 * Math.sqrt(r2));
          ax += dx * k; ay += dy * k; az += dz * k;
        }
        out[id] = { x: ax, y: ay, z: az };
      }
      return out;
    }
    // accels is optional; when supplied the body is extrapolated with ½·a·t².
    bodyAt(body, time, accels, id) {
      const a = (accels && id && accels[id]) || { x: 0, y: 0, z: 0 };
      const t2 = time * time;
      return {
        x: body.x + (body.vx || 0) * time + 0.5 * a.x * t2,
        y: body.y + (body.vy || 0) * time + 0.5 * a.y * t2,
        z: (body.z || 0) + (body.vz || 0) * time + 0.5 * a.z * t2
      };
    }
    // A body's velocity at t. The v + a·t term matters: the on-rails coast and
    // the circular hold rebuild the craft's velocity from the body's velocity,
    // and if they use the START-of-chunk value while the readout compares
    // against the END-of-chunk ephemeris, every chunk injects a spurious
    // a·Δt into the relative velocity. At a 120 s chunk that is 0.71 m/s, which
    // reads as several km of false apoapsis drift per orbit at high warp.
    bodyVelAt(body, time, accels, id) {
      const a = (accels && id && accels[id]) || { x: 0, y: 0, z: 0 };
      return {
        x: (body.vx || 0) + a.x * time,
        y: (body.vy || 0) + a.y * time,
        z: (body.vz || 0) + a.z * time
      };
    }
    progradeHeading(bodies, state = this.s) {
      const id = this.referenceBody(bodies, state), body = bodies[id];
      if (!body) return null;
      const vx = state.v.x - (body.vx || 0), vy = state.v.y - (body.vy || 0);
      if (!(Math.hypot(vx, vy) > 1e-9)) return null;
      return Math.atan2(vy, vx);
    }
    // ---------- analytic coast (on-rails patched conic) ----------
    // Freezes the osculating 2-body orbit at engine cutoff and advances it
    // exactly in 3D: PE/AP/eccentricity cannot drift while unpowered, at any
    // warp. Falls back to numerical integration on thrust, atmosphere drag,
    // or a change of dominant body (SOI handoff re-captures there).
    captureCoast(bodies) {
      const s = this.s;
      if (s.crashed) return false;
      const id = this.referenceBody(bodies, s), body = bodies[id], physical = this.c.bodies[id];
      if (!body || !physical) return false;
      const mu = this.c.G * physical.mass;
      if (!(mu > 0)) return false;
      const rx = s.r.x - body.x, ry = (s.r.y || 0) - (body.y || 0), rz = (s.r.z || 0) - (body.z || 0);
      const vx = s.v.x - (body.vx || 0), vy = (s.v.y || 0) - (body.vy || 0), vz = (s.v.z || 0) - (body.vz || 0);
      const R = Math.sqrt(rx * rx + ry * ry + rz * rz);
      if (!(R > 0) || !Number.isFinite(R) || R < physical.radius_m) return false;
      for (const [bid, b] of Object.entries(bodies)) {
        const p = this.c.bodies[bid]; if (!p) continue;
        const atm = ATMOSPHERES[bid]; if (!atm) continue;
        if (length(sub(s.r, this.bodyAt(b, 0))) - p.radius_m < atm.top) return false;
      }
      const V2 = vx * vx + vy * vy + vz * vz, energy = V2 / 2 - mu / R, rv = rx * vx + ry * vy + rz * vz;
      const hx = ry * vz - rz * vy, hy = rz * vx - rx * vz, hz = rx * vy - ry * vx;
      const h = Math.sqrt(hx * hx + hy * hy + hz * hz);
      if (!(h > 1e-9)) return false;
      const k = V2 - mu / R;
      const eX = (k * rx - rv * vx) / mu, eY = (k * ry - rv * vy) / mu, eZ = (k * rz - rv * vz) / mu;
      const e = Math.sqrt(eX * eX + eY * eY + eZ * eZ);
      if (Math.abs(e - 1) < 1e-6) return false;
      const hyp = e > 1, a = -mu / (2 * energy);
      if (!Number.isFinite(a) || (hyp ? !(a < 0) : !(a > 0))) return false;
      // The 2-body conic is only valid INSIDE the body's sphere of influence.
      // An orbit whose apoapsis (or any escape path) reaches beyond it must
      // fall back to the full N-body integrator, otherwise the on-rails coast
      // would keep curving around the planet long after the primary's gravity
      // has taken over — non-physical energy gains at every warp.
      // The lookup is fully defensive: the nav layer is optional here and an
      // uninitialised/absent module must never break the integrator.
      let soi = null;
      try {
        if (window.ExolineNav && typeof window.ExolineNav.soiRadius === 'function') soi = window.ExolineNav.soiRadius(id);
      } catch (error) { soi = null; }
      if (soi && Number.isFinite(soi)) {
        if (hyp) {
          // Hyperbolic trajectory: only reject if the craft is OUTSIDE the SOI
          // (it has already escaped). If R < soi the craft is on an inbound
          // hyperbolic approach — freeze it as an analytic conic so the SOI
          // entry coast is numerically exact and the body cannot "push away".
          if (R >= soi) return false;
        } else {
          // Elliptic trajectory: reject if apoapsis escapes the SOI.
          const apoapsis = a * (1 + e);
          if (apoapsis > soi) return false;
        }
      }
      // Patched-conic boundary vs OTHER bodies: a frozen 2-body conic is only
      // valid while no third body perturbs the arc. Earth's Laplace SOI is
      // ~1.5M km, so a TLI-class transfer (apoapsis ~400,000 km) sits well
      // inside it and the SOI guard above happily freezes it — yet the arc
      // passes straight through the Moon's Hill sphere, where the Moon bends
      // the real trajectory. The prediction is full N-body, so the frozen Earth
      // conic diverges from it near the Moon and the craft arrives on the wrong
      // path, sailing past the capture node. Reject any elliptic arc whose
      // apoapsis reaches into another body's SOI so it falls through to the RK4
      // N-body integrator, which matches the prediction exactly. The
      // reach = dB - soiB > 0 test skips the parent (its SOI encloses the arc),
      // so LEO/GEO and normal lunar orbits still freeze — only transfers into
      // another body's neighbourhood drop to integration.
      if (!hyp) {
        const apoapsis = a * (1 + e);
        for (const [bid, b] of Object.entries(bodies)) {
          if (bid === id) continue;
          const p = this.c.bodies[bid];
          if (!p || !p.solidSurface) continue;
          let soiB = null;
          try {
            if (window.ExolineNav && typeof window.ExolineNav.soiRadius === 'function') soiB = window.ExolineNav.soiRadius(bid);
          } catch (error) { soiB = null; }
          if (!soiB || !Number.isFinite(soiB)) continue;
          const dB = length(sub(b, body)), reach = dB - soiB;
          if (reach > 0 && apoapsis > reach) return false;
        }
      }
      // Periapsis-inside-atmosphere guard: if the orbit's periapsis would dip
      // below the reference body's atmosphere top, the frozen 2-body conic is
      // wrong — it ignores drag and causes the "skipping stone" reentry bounce
      // where the craft re-captures a conic each time drag pops it back above
      // the atmosphere, then drops back through the tenuous top, repeating.
      if (!hyp) {
        const periapsis = a * (1 - e);
        const atmRef = ATMOSPHERES[id];
        if (atmRef && periapsis - physical.radius_m < atmRef.top) return false;
      }
      const Wx = hx / h, Wy = hy / h, Wz = hz / h;
      let Px, Py, Pz;
      if (e > 1e-9) { Px = eX / e; Py = eY / e; Pz = eZ / e; }
      else { Px = rx / R; Py = ry / R; Pz = rz / R; }
      const Qx = Wy * Pz - Wz * Py, Qy = Wz * Px - Wx * Pz, Qz = Wx * Py - Wy * Px;
      const n = Math.sqrt(mu / Math.pow(Math.abs(a), 3));
      let M, E0;
      if (!hyp) {
        if (e > 1e-9) {
          const cosE = Math.max(-1, Math.min(1, (1 - R / a) / e));
          const sinE = rv / (e * Math.sqrt(mu * a));
          E0 = Math.atan2(sinE, cosE);
        } else {
          E0 = 0; // circular: periapsis direction was set to current r-hat
        }
        M = E0 - e * Math.sin(E0);
      } else {
        const sh = Math.max(-1e6, Math.min(1e6, rv / (e * Math.sqrt(mu * Math.abs(a)))));
        E0 = Math.asinh(sh);
        M = e * Math.sinh(E0) - E0;
      }
      const conic = { body: id, mu, a, e, hyp, Px, Py, Pz, Qx, Qy, Qz, n, M, E: E0, radius: physical.radius_m };
      // Patched-conic boundary (accurate, forward-propagated) for ESCAPE arcs.
      // The elliptic case above is gated by the apoapsis heuristic, but a
      // hyperbolic transfer has no apoapsis — a TLI burn leaves Earth on an
      // escape hyperbola that the old code froze as a straight 2-body conic,
      // ignoring the Moon, while the prediction integrated full N-body and
      // curved into it. That split is the "ESCAPE" mismatch and the reason the
      // craft sailed past the capture node. Walk the conic forward and reject
      // the freeze the instant it enters another solid body's SOI so the RK4
      // N-body integrator (identical model to the prediction) flies the arc.
      // BOTH elliptic and hyperbolic arcs are gated here. The elliptic apoapsis
      // guard above only rejects arcs that escape the REFERENCE SOI; a sub-SOI
      // translunar arc (apoapsis ~400k km, still < Earth's 1.5M km SOI) sails
      // straight through the Moon's Hill sphere, so gating this on `hyp` alone
      // froze it as a pure 2-body Earth conic that ignored the Moon — diverging
      // from the N-body prediction near the Moon (the "ESCAPE" mismatch) and
      // missing the capture node. _coastCrossesSoi already solves both conic
      // types, so drop the `hyp &&` and let any SOI-entering arc fall through to
      // the RK4 N-body integrator, which is the same model the prediction uses.
      if (this._coastCrossesSoi(conic, bodies, id)) return false;
      this.coast = conic;
      return true;
    }
    // Forward-propagate a frozen conic and report whether it enters any OTHER
    // solid body's sphere of influence before leaving the reference body's SOI
    // (or a bounded horizon). The prediction switches frames at exactly these
    // boundaries; freezing a 2-body arc across one makes the live craft diverge
    // from the dashed path, so captureCoast rejects it and lets RK4 take over.
    // Coarse steps are fine — this is a yes/no SOI gate, not the trajectory,
    // and it only ever errs toward integrating (which is always correct).
    _coastCrossesSoi(conic, bodies, refId) {
      const targets = [];
      for (const bid of Object.keys(bodies)) {
        if (bid === refId) continue;
        const p = this.c.bodies[bid];
        if (!p || !p.solidSurface) continue;
        let soiB = null;
        try { if (window.ExolineNav && typeof window.ExolineNav.soiRadius === 'function') soiB = window.ExolineNav.soiRadius(bid); } catch (error) { soiB = null; }
        if (soiB && Number.isFinite(soiB) && soiB > p.radius_m) targets.push({ bid, soiB });
      }
      if (!targets.length) return false;
      let refSoi = null;
      try { if (window.ExolineNav && typeof window.ExolineNav.soiRadius === 'function') refSoi = window.ExolineNav.soiRadius(refId); } catch (error) { refSoi = null; }
      const accels = this._accMap || this.bodyAccelerations(bodies);
      const refBody0 = bodies[refId];
      if (!refBody0) return false;
      let M = conic.M, E = conic.E, elapsed = 0;
      const dt = 900; // 15-min coarse steps
      for (let step = 0; step < 640; step++) { // ~9.6-day horizon covers any transfer
        M += conic.n * dt;
        for (let i = 0; i < 20; i++) {
          const d = conic.hyp
            ? (conic.e * Math.sinh(E) - E - M) / Math.max(1e-12, conic.e * Math.cosh(E) - 1)
            : (E - conic.e * Math.sin(E) - M) / Math.max(1e-12, 1 - conic.e * Math.cos(E));
          E -= d;
          if (Math.abs(d) < 1e-9) break;
        }
        if (!Number.isFinite(E)) return false;
        let ox, oy;
        if (!conic.hyp) {
          const cE = Math.cos(E), sE = Math.sin(E), sq = Math.sqrt(Math.max(0, 1 - conic.e * conic.e));
          ox = conic.a * (cE - conic.e); oy = conic.a * sq * sE;
        } else {
          const ch = Math.cosh(E), sh = Math.sinh(E), sq = Math.sqrt(conic.e * conic.e - 1), aa = Math.abs(conic.a);
          ox = -aa * (ch - conic.e); oy = aa * sq * sh;
        }
        elapsed += dt;
        const bp = this.bodyAt(refBody0, elapsed, accels, refId);
        const px = bp.x + ox * conic.Px + oy * conic.Qx;
        const py = bp.y + ox * conic.Py + oy * conic.Qy;
        const pz = (bp.z || 0) + ox * conic.Pz + oy * conic.Qz;
        // Left the reference SOI cleanly -> a valid single-body coast.
        if (refSoi && Number.isFinite(refSoi) && Math.hypot(px - bp.x, py - bp.y, pz - (bp.z || 0)) > refSoi) return false;
        for (const t of targets) {
          const tb = this.bodyAt(bodies[t.bid], elapsed, accels, t.bid);
          if (Math.hypot(px - tb.x, py - tb.y, pz - (tb.z || 0)) < t.soiB) return true;
        }
      }
      return false;
    }
    advanceCoast(seconds, bodies) {
      const c = this.coast;
      if (!c) return false;
      // Second-order body extrapolation for the whole coast (see bodyAccelerations).
      const accels = this._accMap || this.bodyAccelerations(bodies);
      let remaining = seconds;
      let elapsed = 0;
      while (remaining > 1e-9) {
        const dt = Math.min(10, remaining);
        elapsed += dt;
        const body = bodies[c.body];
        if (!body) { this.coast = null; return false; }
        // SOI changed: drop the frozen conic and let the caller fall through
        // to RK4 for the remaining time.  Do NOT return false immediately —
        // that would skip physics entirely for the rest of this frame and
        // inject a sudden velocity discontinuity that reads as "pushed away".
        if (this.referenceBody(bodies, this.s) !== c.body) { this.coast = null; return false; }
        c.M += c.n * dt;
        let E = c.E;
        if (!c.hyp) {
          for (let i = 0; i < 8; i++) { const d = (E - c.e * Math.sin(E) - c.M) / Math.max(1e-12, 1 - c.e * Math.cos(E)); E -= d; if (Math.abs(d) < 1e-12) break; }
        } else {
          for (let i = 0; i < 16; i++) { const d = (c.e * Math.sinh(E) - E - c.M) / Math.max(1e-12, c.e * Math.cosh(E) - 1); E -= d; if (Math.abs(d) < 1e-12) break; }
        }
        if (!Number.isFinite(E)) { this.coast = null; return false; }
        c.E = E;
        let ox, oy, oz, ovx, ovy, ovz, R1;
        if (!c.hyp) {
          const cE = Math.cos(E), sE = Math.sin(E), sq = Math.sqrt(Math.max(0, 1 - c.e * c.e));
          R1 = c.a * (1 - c.e * cE);
          const f = Math.sqrt(c.mu * c.a) / Math.max(R1, 1e-9);
          ox = c.a * (cE - c.e); oy = c.a * sq * sE; oz = 0;
          ovx = -f * sE; ovy = f * sq * cE; ovz = 0;
        } else {
          const ch = Math.cosh(E), sh = Math.sinh(E), sq = Math.sqrt(c.e * c.e - 1), aa = Math.abs(c.a);
          R1 = aa * (c.e * ch - 1);
          const f = Math.sqrt(c.mu * aa) / Math.max(R1, 1e-9);
          ox = -aa * (ch - c.e); oy = aa * sq * sh; oz = 0;
          ovx = -f * sh; ovy = f * sq * ch; ovz = 0;
        }
        const bp = this.bodyAt(body, elapsed, accels, c.body);
        const bv = this.bodyVelAt(body, elapsed, accels, c.body);
        this.s.r = { x: bp.x + ox * c.Px + oy * c.Qx, y: bp.y + ox * c.Py + oy * c.Qy, z: (bp.z || 0) + ox * c.Pz + oy * c.Qz };
        this.s.v = { x: bv.x + ovx * c.Px + ovy * c.Qx, y: bv.y + ovx * c.Py + ovy * c.Qy, z: bv.z + ovx * c.Pz + ovy * c.Qz };
        for (const [bid, b] of Object.entries(bodies)) {
          const p = this.c.bodies[bid]; if (!p) continue;
          // Gas bodies have no surface: an analytic coast passes through them.
          if (p.solidSurface) {
            const crashAt = this.bodyAt(b, elapsed, accels, bid);
            const crashRel = sub(this.s.r, crashAt), crashDist = length(crashRel);
            if (crashDist < p.radius_m) {
              // Impenetrable crust: an analytic arc that crosses the surface
              // stops with the wreck ON the crust, never buried inside.
              this.s.crashed = true; this.s.throttle = 0; this.coast = null;
              const cx = crashDist > 1e-6 ? crashRel.x / crashDist : 0;
              const cy = crashDist > 1e-6 ? crashRel.y / crashDist : 1;
              const cz = crashDist > 1e-6 ? crashRel.z / crashDist : 0;
              this.s.r = { x: crashAt.x + cx * p.radius_m, y: crashAt.y + cy * p.radius_m, z: (crashAt.z || 0) + cz * p.radius_m };
              return true;
            }
          }
        }
        const atm = ATMOSPHERES[c.body];
        if (atm && R1 - c.radius < atm.top) { this.coast = null; return false; }
        remaining -= dt;
      }
      return true;
    }
    acc(position, bodies, time = 0, velocity = this.s.v, accels = this._accMap) {
      let acceleration = { x: 0, y: 0, z: 0 };
      for (const [id, initial] of Object.entries(bodies)) {
        const physical = this.c.bodies[id]; if (!physical) continue;
        const at = this.bodyAt(initial, time, accels, id);
        const displacement = sub(position, at), squared = dot(displacement, displacement);
        if (squared <= 1) continue;
        acceleration = add(acceleration, mul(displacement, -this.c.G * physical.mass / (squared * Math.sqrt(squared))));
        const velAt = this.bodyVelAt(initial, time, accels, id);
        const bodyFrame = { ...at, vx: velAt.x, vy: velAt.y, vz: velAt.z };
        // v0.1.2: combined drag (base + induced) plus AoA lift. Bodies without
        // an atmosphere return {0,0,0} from aeroAccel, so no double counting.
        acceleration = add(acceleration, aeroAccel(position, velocity, bodyFrame, { ...physical, id }, this.s.m, this.s.heading, this.s.chuteAlive));
        // Parachute: extra drag opposite vrel while deployed and intact. Uses
        // its own Cd*A = CHUTE_CD * CHUTE_AREA (= 1.5*40 = 60) on top of the
        // (lift-free) body drag.
        if (this.s.chuteDeployed && this.s.chuteAlive) {
          const cvx = velocity.x - velAt.x, cvy = velocity.y - velAt.y;
          const cspeed = Math.hypot(cvx, cvy);
          if (cspeed > 1e-6) {
            const crho = atmosphereDensity(position, bodyFrame, { ...physical, id });
            if (crho > 0) {
              const chuteAccel = 0.5 * crho * cspeed * cspeed * (CHUTE_CD * CHUTE_AREA) / Math.max(this.s.m, 1);
              acceleration = add(acceleration, { x: -cvx / cspeed * chuteAccel, y: -cvy / cspeed * chuteAccel, z: 0 });
            }
          }
        }
      }
      const usableThrottle = (this.infiniteFuel || this.s.propellant > 0) && !this.s.crashed ? this.s.throttle : 0;
      const safeMass = Math.max(this.s.m, 1);
      return add(acceleration, mul({ x: Math.cos(this.s.heading), y: Math.sin(this.s.heading), z: 0 }, this.thrust * usableThrottle / safeMass));
    }
    rk4(dt, bodies, time) {
      const state = this.s;
      // The body-acceleration map is fixed for the whole step, so all four RK4
      // stages extrapolate the ephemeris consistently.
      rk4Step(state, dt, (r, offset, v) => this.acc(r, bodies, time + offset, v));
      if (!Number.isFinite(state.r.x) || !Number.isFinite(state.r.y) || !Number.isFinite(state.v.x) || !Number.isFinite(state.v.y)) {
        this.s.crashed = true;
        this.s.throttle = 0;
        console.warn('[FlightEngine] NaN detected in state. Setting crashed.');
        return;
      }
      // Guard on valid stage thrust/Isp: an unlaunched engine (0/0) would
      // compute NaN here, poison s.propellant/s.m, and cascade NaN into the
      // next acceleration call.
      if (!this.infiniteFuel && this.thrust > 0 && this.specificImpulse > 0) {
        const burn = this.thrust * Math.max(0, state.throttle) / (this.specificImpulse * 9.80665) * dt;
        const used = Math.min(state.propellant, burn); state.propellant -= used; state.m = this.dryMass + state.propellant + this.payloadMass;
        state.propellant = Math.max(0, state.propellant);
        if (used < burn) state.throttle = 0;
      }
    }
    // ---------- reference body selection ----------
    // The body the craft is "orbiting" must be chosen by SPHERE OF INFLUENCE,
    // never by instantaneous gravity pull.
    //
    // dominant() compares raw GM/r², which is the wrong criterion: it flips to
    // the Sun at ~259,000 km from Earth — 5.7x INSIDE Earth's Hill sphere
    // (1.47 million km). Above that altitude three things break at once:
    //   1. captureCoast re-captures a heliocentric conic, so a coasting craft
    //      with zero throttle suddenly starts "escaping".
    //   2. advanceCoast's dominance guard fails and the analytic coast is
    //      dropped mid-orbit, throwing away the exact frozen arc.
    //   3. maximumStep sizes itself on the SUN's orbital period, producing
    //      ~180 s steps on what is still an Earth orbit — which smashes the
    //      integrator and drives the craft into the planet (auto-burn crash).
    //
    // The Hill sphere is the physically correct boundary, and it is what the
    // navigation layer already uses (soiBody in app.js). Guarded: the nav module
    // is optional, and when it is unavailable we fall back to dominant().
    referenceBody(bodies, state = this.s) {
      const physicals = this.c && this.c.bodies;
      if (!physicals) return 'sun';
      let soi = null, refId = null;
      try {
        if (window.ExolineNav && typeof window.ExolineNav.soiRadius === 'function') {
          let best = null;
          for (const id of Object.keys(physicals)) {
            if (id === 'sun') continue;
            const radius = window.ExolineNav.soiRadius(id);
            if (!(Number.isFinite(radius)) || !(radius > 0)) continue;
            const body = bodies[id];
            if (!body) continue;
            const distance = length(sub(state.r, body));
            if (distance > radius) continue;          // outside this SOI: skip
            // deepest containing SOI wins (e.g. a moon inside a planet's SOI)
            if (!best || radius < best.radius) best = { id, radius };
          }
          refId = best ? best.id : null;
          soi = best ? best.radius : null;
        }
      } catch (error) { refId = null; }
      if (refId) return refId;
      // Fallback: instantaneous dominance, but bounded by the Sun only when
      // the craft is genuinely beyond every SOI (deep space).
      let greatest = 0, id = 'sun';
      for (const [key, body] of Object.entries(bodies)) {
        const physical = physicals[key]; if (!physical) continue;
        const distance = length(sub(state.r, body)), pull = this.c.G * physical.mass / (distance * distance);
        if (pull > greatest) { greatest = pull; id = key; }
      }
      return id;
    }
    dominant(bodies, state = this.s) { let id = 'sun', greatest = 0; for (const [key, body] of Object.entries(bodies)) { const physical = this.c.bodies[key]; if (!physical) continue; const distance = length(sub(state.r, body)), pull = this.c.G * physical.mass / (distance * distance); if (pull > greatest) { greatest = pull; id = key; } } return id; }
    maximumStep(bodies, state = this.s) {
      const id = this.referenceBody(bodies, state), body = bodies[id], physical = this.c.bodies[id], radius = length(sub(state.r, body)), period = 2 * Math.PI * Math.sqrt(radius ** 3 / (this.c.G * physical.mass));
      // A tighter orbital step keeps osculating PE/AP stable after a coast or
      // burn, particularly while the craft is close to its SOI primary.
      const orbitalLimit = Math.max(.125, Math.min(180, period / 2400));
      let limit = Math.min(orbitalLimit, atmosphereStepLimit(state.r, state.v, bodies, this.c, state.m));
      // Anti-tunnel guard: while closing on any solid surface, never take a step
      // long enough to cross it. Without this a fast entry leaps from thin air
      // to below the crust in a single RK4 substep, where the density model
      // reads zero and drag disappears — the craft then either tunnels through
      // or is ejected back out (the reentry "bounce"). Capping the step to the
      // FULL time-to-surface lets a substep advance at most to the crust, so
      // resolveContacts always meets it. (Half the time-to-surface is NOT used:
      // with per-substep recompute it halves the altitude every step — a Zeno
      // approach that never quite reaches the surface. Gas giants are skipped.)
      for (const [bid, b] of Object.entries(bodies)) {
        const p = this.c.bodies[bid];
        if (!p || p.solidSurface === false) continue;
        const rel = sub(state.r, b), dist = length(rel);
        const surfAlt = dist - p.radius_m;
        if (!(surfAlt > 0)) continue;
        const vRel = sub(state.v, { x: b.vx || 0, y: b.vy || 0, z: b.vz || 0 });
        const vRad = dot(vRel, rel) / dist;          // radial closing speed (+outward)
        if (vRad < -1) {
          const cross = surfAlt / -vRad;             // seconds until surface contact
          limit = Math.min(limit, Math.max(0.02, cross));
        }
      }
      return limit;
    }
    // Contact resolution shared by every integrator substep: land on solid
    // surfaces, crash on hard solid impacts, and pass straight through gas
    // bodies (drag and heating still apply). Returns true once the craft has
    // landed or crashed so the step stops integrating.
    resolveContacts(bodies, tAbs) {
      if (this.s.crashed) return true;
      const accels = this._accMap;
      for (const [id, body] of Object.entries(bodies)) {
        const physical = this.c.bodies[id];
        if (!physical) continue;
        const at = this.bodyAt(body, tAbs, accels, id);
        const rel = sub(this.s.r, at);
        const distance = length(rel);
        if (!(distance < physical.radius_m)) continue;
        if (!physical.solidSurface) continue;             // gas body: pass through
        const vRel = sub(this.s.v, this.bodyVelAt(body, tAbs, accels, id));
        const vRadial = dot(vRel, rel);
        const speedRel = length(vRel);
        // Snap-and-continue is ONLY for sub-meter liftoff/ephemeris jitter: a
        // craft climbing gently off the pad can momentarily sit a hair below the
        // computed crust, so we lift it back and keep going. Gated on LOW speed.
        // A reentry craft that tunnels to the surface with an OUTWARD velocity
        // (from a drag overshoot) must NOT take this branch — snapping it back
        // with that outward speed intact and continuing is exactly the
        // atmosphere "bounce," and every bounce raises the osculating perigee.
        // At speed it falls through to the crash/land handling below so contact
        // terminates cleanly instead of ratcheting the orbit back up.
        if (vRadial > 0 && speedRel < 10) {
          const nx = distance > 1e-6 ? rel.x / distance : 0;
          const ny = distance > 1e-6 ? rel.y / distance : 1;
          const nz = distance > 1e-6 ? rel.z / distance : 0;
          this.s.r = { x: at.x + nx * physical.radius_m, y: at.y + ny * physical.radius_m, z: (at.z || 0) + nz * physical.radius_m };
          continue;
        }
        this.reentryState.bodyId = id;
        if (length(vRel) < 10) {
          // Soft touchdown: clamp exactly to the surface and ride the body.
          this.s.landed = true;
          this.s.throttle = 0;
          this.landedBody = id;
          this.landedDir = distance > 0 ? { x: rel.x / distance, y: rel.y / distance, z: rel.z / distance } : { x: 0, y: 1, z: 0 };
          this.s.r = { x: at.x + this.landedDir.x * physical.radius_m, y: at.y + this.landedDir.y * physical.radius_m, z: (at.z || 0) + this.landedDir.z * physical.radius_m };
          this.s.v = { x: body.vx || 0, y: body.vy || 0, z: body.vz || 0 };
          this.reentryState.phase = 'LANDED';
        } else {
          this.s.crashed = true;
          this.s.throttle = 0;
          this.reentryState.phase = 'CRASHED';
          // Impenetrable crust: park the wreck exactly ON the surface so a
          // craft is never left buried inside a solid body after an impact.
          const nx = distance > 1e-6 ? rel.x / distance : 0;
          const ny = distance > 1e-6 ? rel.y / distance : 1;
          const nz = distance > 1e-6 ? rel.z / distance : 0;
          this.s.r = { x: at.x + nx * physical.radius_m, y: at.y + ny * physical.radius_m, z: (at.z || 0) + nz * physical.radius_m };
        }
        return true;
      }
      return false;
    }
    step(seconds, bodies) {
      if (!seconds || this.s.crashed) return;
      if (this.s.throttle > 0) { this.circularHold = null; this.coast = null; }
      // A landed craft rides the moving body: re-pin to the surface each step
      // preserving the body-relative angle so it never drifts or sinks.
      // Throttling up releases it ONLY if TWR > 1.
      if (this.s.landed) {
        const lid = this.landedBody || this.referenceBody(bodies, this.s);
        const body = bodies[lid], physical = this.c.bodies[lid];
        // Defensive: a loaded save can carry landed=true with no direction.
        // Rebuild it from the current radius instead of dereferencing null.
        if (!this.landedDir && body && physical) {
          const rel = sub(this.s.r, body), d = length(rel);
          this.landedDir = d > 1e-6 ? { x: rel.x / d, y: rel.y / d, z: rel.z / d } : { x: 0, y: 1, z: 0 };
        }
        if (this.s.throttle > 0 && body && physical) {
          // TWR = thrust * throttle / (mass * local_g) — gated on the EFFECTIVE
          // throttle. A dry tank produces zero thrust regardless of the engine's
          // rating, so a fuel-blind check would release the pin (TWR > 1 on
          // paper) with nothing pushing up and the craft free-falls into the
          // pad. With no propellant the gate now reads TWR = 0 and holds.
          const local_g = this.c.G * physical.mass / (physical.radius_m * physical.radius_m);
          const effectiveThrottle = (this.infiniteFuel || this.s.propellant > 0) ? this.s.throttle : 0;
          const twr = (this.thrust * effectiveThrottle) / (this.s.m * local_g);
          if (twr > 1.0) {
            // TWR > 1: liftoff! Un-pin and transition to flying
            this.s.r = { x: body.x + this.landedDir.x * physical.radius_m, y: body.y + this.landedDir.y * physical.radius_m, z: (body.z || 0) + this.landedDir.z * physical.radius_m };
            this.s.v = { x: body.vx || 0, y: body.vy || 0, z: body.vz || 0 };
            this.s.landed = false;
            this.landedBody = null;
            this.landedDir = null;
            console.info(`[liftoff] TWR=${twr.toFixed(2)} > 1.0, transitioning to flight`);
          } else {
            // TWR <= 1: remain pinned (no upward translation at all) but the
            // engine keeps burning propellant exactly as rk4 would — holding
            // on the pad is not free. Aerodynamic heating stays 0 by the
            // existing model (q/heating scale with airspeed; a parked craft
            // has none — there is no thrust-heating model).
            this.s.r = { x: body.x + this.landedDir.x * physical.radius_m, y: body.y + this.landedDir.y * physical.radius_m, z: (body.z || 0) + this.landedDir.z * physical.radius_m };
            this.s.v = { x: body.vx || 0, y: body.vy || 0, z: body.vz || 0 };
            if (!this.infiniteFuel && this.thrust > 0 && this.specificImpulse > 0) {
              const burn = this.thrust * Math.max(0, this.s.throttle) / (this.specificImpulse * 9.80665) * seconds;
              const used = Math.min(this.s.propellant, burn);
              this.s.propellant = Math.max(0, this.s.propellant - used);
              this.s.m = this.dryMass + this.s.propellant + this.payloadMass;
              // Cut the throttle when the tank runs dry OR was already dry, so
              // the IGNITION button flips back and the T/W readout can't show
              // a healthy value for an engine that cannot fire.
              if (used < burn || this.s.propellant <= 0) this.s.throttle = 0;
            }
            this.prevThrottle = this.s.throttle;
            return; // Pinned: skip integration entirely.
          }
        } else if (body && physical && this.landedDir) {
          // No throttle: re-pin to surface
          this.s.r = { x: body.x + this.landedDir.x * physical.radius_m, y: body.y + this.landedDir.y * physical.radius_m, z: (body.z || 0) + this.landedDir.z * physical.radius_m };
          this.s.v = { x: body.vx || 0, y: body.vy || 0, z: body.vz || 0 };
          this.s.throttle = 0; this.prevThrottle = 0;
          return;
        }
      }

      // Ascent Mode: gravity turn automation
      if (this.ascentMode && !this.s.landed) {
        const refId = this.referenceBody(bodies, this.s);
        const refBody = bodies[refId];
        const refPhysical = this.c.bodies[refId];
        if (refBody && refPhysical) {
          const rel = sub(this.s.r, refBody);
          const distance = length(rel);
          const altitude = distance - refPhysical.radius_m;
          const atm = ATMOSPHERES[refId];
          // Get prograde heading (velocity vector relative to body)
          const vRel = sub(this.s.v, { x: refBody.vx || 0, y: refBody.vy || 0, z: refBody.vz || 0 });
          const progradeHeading = Math.atan2(vRel.y, vRel.x);
          // Surface normal heading (straight up). Thrust aims along
          // (cos h, sin h) — see acc() — so the heading that points the nose
          // radially outward IS the normal's own angle. (The old -PI/2 offset
          // aimed 90 degrees off: tangential along the surface.)
          const surfaceNormalHeading = Math.atan2(rel.y, rel.x);
          let targetHeading;
          if (altitude < 500) {
            // Below 500m: go straight up
            targetHeading = surfaceNormalHeading;
          } else {
            // Above 500m: smoothly interpolate toward prograde
            const angleDiff = progradeHeading - this.s.heading;
            // Normalize to [-PI, PI]
            const normalizedDiff = Math.atan2(Math.sin(angleDiff), Math.cos(angleDiff));
            // Interpolate factor based on altitude (smooth transition)
            const interpFactor = Math.min(1, Math.max(0, (altitude - 500) / 5000));
            targetHeading = this.s.heading + normalizedDiff * interpFactor;
          }
          // Pitch rate limit: max 5 deg/s = 0.0873 rad/s
          const maxTurn = 0.0873 * seconds;
          let angleToTarget = targetHeading - this.s.heading;
          angleToTarget = Math.atan2(Math.sin(angleToTarget), Math.cos(angleToTarget));
          const limitedAngle = Math.max(-maxTurn, Math.min(maxTurn, angleToTarget));
          this.s.heading += limitedAngle;
          // Auto-disable ascent mode above atmosphere (or in vacuum)
          if ((atm && altitude >= atm.top) || (!atm && altitude > refPhysical.radius_m)) {
            this.ascentMode = false;
            console.info('[ascent] Auto-disabled: above atmosphere');
          }
        }
      }
      // Cache body accelerations for this whole step: every RK4 stage and every
      // crash probe then extrapolates the ephemeris with the same second-order
      // model, which is what keeps the reference body from curving away from
      // the craft between ephemeris re-syncs.
      this._accMap = this.bodyAccelerations(bodies);
      // Prograde lock tracks the orbit as it curves, re-snapping every RK4
      // substep so long high-warp frames can't go stale mid-burn.
      const lock = this.progradeLock && !this.ascentMode && !this.steerOverride && !this.manualSteer && this.s.throttle > 0 && !this.s.crashed;
      const lockId = lock ? this.referenceBody(bodies, this.s) : null;
      const lockBody = lock && lockId ? bodies[lockId] : null;
      const lockPhysical = lock && lockId ? this.c.bodies[lockId] : null;
      const powered = this.s.throttle > 0;
      if (!powered && !this.circularHold && !this.coast && !this.s.crashed) this.captureCoast(bodies);
      if (this.coast && !powered && !this.s.crashed) {
        const ok = this.advanceCoast(seconds, bodies);
        this.prevThrottle = this.s.throttle;
        if (ok || this.s.crashed) return;
        // advanceCoast bailed (SOI transition, atmosphere entry, etc.).
        // Try re-capturing a coast in the new reference body's frame. If that
        // succeeds we're done for this step; if it fails the craft drops into
        // the RK4 integrator below so physics always advances — never skipped.
        this.coast = null;
        if (this.captureCoast(bodies)) return;
        // Fall through to RK4 for numerical integration.
      }
      if (this.circularHold && this.s.throttle === 0) { this.advanceCircularHold(seconds, bodies); this.prevThrottle = this.s.throttle; return; }
      // Adaptive substeps: maximumStep is recomputed EVERY substep, not once per
      // chunk. Sized only at the thin entry altitude it stays ~5 s while drag
      // climbs by orders of magnitude during the plunge, and a fixed 5 s explicit
      // RK4 step overshoots the stiff lower-atmosphere drag — spuriously
      // reversing velocity, which resolveContacts turns into the reentry
      // "bounce" and a perigee that ratchets up after every touch. Recomputing dt
      // lets it collapse as density rises (see atmosphereStepLimit) and as the
      // craft closes on the surface (see the anti-tunnel guard in maximumStep),
      // so the descent is stable and monotonic into a clean land/crash. The loop
      // tracks elapsed time so each substep's dt also never overshoots the chunk.
      let elapsed = 0;
      while (elapsed < seconds - 1e-9) {
        const step = this.maximumStep(bodies);
        const dt = Math.min(step, seconds - elapsed);
        if (lockBody) {
          const ldx = this.s.r.x - lockBody.x, ldy = this.s.r.y - lockBody.y, ldz = (this.s.r.z || 0) - (lockBody.z || 0);
          const lDist = Math.hypot(ldx, ldy, ldz);
          const lAlt = lockPhysical ? lDist - lockPhysical.radius_m : Infinity;
          const lvx = this.s.v.x - (lockBody.vx || 0), lvy = this.s.v.y - (lockBody.vy || 0);
          const lSpeed = Math.hypot(lvx, lvy);
          if (lAlt >= 500 && lSpeed >= 50) this.s.heading = Math.atan2(lvy, lvx);
        }
        this.rk4(dt, bodies, elapsed);
        elapsed += dt;
        // v0.1.2: heat the skin every substep off the same interpolated
        // ephemeris the integrator used, so temperature tracks the actual
        // density profile instead of the coarser per-chunk sample. Uses the
        // post-push state and the extrapolated reference-body frame.
        try {
          const hId = this.referenceBody(bodies, this.s);
          const hBody = hId && bodies[hId], hPhys = hId && this.c.bodies[hId];
          if (hBody && hPhys && ATMOSPHERES[hId]) {
            const hAt = this.bodyAt(hBody, elapsed, this._accMap, hId);
            const hVel = this.bodyVelAt(hBody, elapsed, this._accMap, hId);
            const hRho = atmosphereDensity(this.s.r, hAt, { ...hPhys, id: hId }) || 0;
            if (hRho > 0) this.thermalStep(hRho, this.s.v.x - hVel.x, this.s.v.y - hVel.y, dt);
            else this.s.shieldFacing = false;
          } else this.s.shieldFacing = false;
        } catch (e) { /* thermal is display-only: never break the step */ }
        if (this.s.crashed) break; // thermal breakup ends the chunk early
        if (this.resolveContacts(bodies, elapsed)) break;
      }

      // --- Reentry phase tracking (per dominant body) ---
      const refId = this.referenceBody(bodies, this.s);
      const refBody = bodies[refId];
      const refPhysical = this.c.bodies[refId];
      if (refBody && refPhysical) {
        const atm = ATMOSPHERES[refId];
        const endBody = this.bodyAt(refBody, seconds, this._accMap, refId);
        const endVel = this.bodyVelAt(refBody, seconds, this._accMap, refId);
        const rel = sub(this.s.r, endBody);
        const distance = length(rel);
        const altitude = distance - refPhysical.radius_m;
        const vRel = length(sub(this.s.v, endVel));
        const rho = atm ? (atmosphereDensity(this.s.r, endBody, { ...refPhysical, id: refId }) || 0) : 0;

        // Reset tracking when the dominant body changes.
        if (this.reentryState.bodyId !== refId) {
          this.reentryState = { bodyId: refId, phase: 'EXO', q: 0, rho: 0, heating: 0, gLoad: 0, alt: altitude, peakHeating: 0, peakG: 0 };
        }
        const rs = this.reentryState;
        const prevPhase = rs.phase;
        rs.bodyId = refId; rs.rho = rho; rs.alt = altitude;

        // EXO -> ENTRY -> DESCENT -> terminal (LANDED / CRASHED / PASSTHROUGH).
        if (this.s.crashed) rs.phase = 'CRASHED';
        else if (this.s.landed) rs.phase = 'LANDED';
        else if (!refPhysical.solidSurface && altitude < 0) rs.phase = 'PASSTHROUGH';
        else if (rho > 0 && vRel > 1000) rs.phase = 'ENTRY';
        else if (rho > 0 && (vRel <= 1000 || (atm && altitude < 0.1 * atm.top))) rs.phase = 'DESCENT';
        else rs.phase = 'EXO';

        if (rho > 0 && vRel > 0) {
          const q = 0.5 * rho * vRel * vRel;
          const heating = Math.sqrt(rho) * vRel * vRel * vRel * 1e-4;
          const dragAccel = 0.5 * rho * vRel * vRel * DRAG_CD * DRAG_AREA / Math.max(this.s.m, 1);
          const gLoad = dragAccel / 9.80665;
          rs.q = q; rs.heating = heating; rs.gLoad = gLoad;
          if (heating > rs.peakHeating) rs.peakHeating = heating;
          if (gLoad > rs.peakG) rs.peakG = gLoad;
        } else {
          rs.q = 0; rs.heating = 0; rs.gLoad = 0;
        }
        // v0.1.2 aerobraking / aerocapture. An in-air pass on escape-energy
        // reads AEROBRAKE (never ENTRY/DESCENT) and latches wasAero; leaving
        // the air still latched but now bound raises the one-shot
        // aerocapturePing that the HUD toasts as "AEROCAPTURE: BOUND ORBIT".
        // Energy is the live specific orbital energy vs the reference body —
        // >= 0 is escape/hyperbolic, < 0 is bound. Clears whenever the craft
        // is terminal (LANDED / CRASHED / BURNUP) or out of the air and bound.
        try {
          const muRef = this.c.G * refPhysical.mass;
          const escaping = vRel * vRel / 2 - muRef / Math.max(distance, 1) >= 0;
          if (rs.phase !== 'BURNUP' && !this.s.crashed && !this.s.landed && rho > 0 && vRel > 1000 && escaping && rs.phase !== 'AEROBRAKE') {
            rs.phase = 'AEROBRAKE';
          }
          if (rs.phase === 'AEROBRAKE') rs.wasAero = true;
          if (rs.wasAero && !escaping && (!(rho > 0) || rs.phase === 'EXO')) {
            rs.wasAero = false;
            rs.aerocapturePing = true;
            console.info(`[aerocapture] ${refId} AEROCAPTURE: BOUND ORBIT  vrel=${vRel.toFixed(0)} m/s  alt=${altitude.toFixed(0)} m`);
          }
          if ((this.s.landed || this.s.crashed) && rs.phase !== 'AEROBRAKE') rs.wasAero = false;
        } catch (e) { /* aerobrake is advisory: never touch the phase chain */ }
        if (rs.phase !== prevPhase) console.info(`[reentry] ${refId} ${prevPhase} -> ${rs.phase}  rho=${rho.toExponential(2)} kg/m3  q=${rs.q.toFixed(1)}  vrel=${vRel.toFixed(0)} m/s  alt=${altitude.toFixed(0)} m`);
      }

      this.prevThrottle = this.s.throttle;
    }
    diagnostics(bodies, target) {
      const id = this.referenceBody(bodies), body = bodies[id], physical = this.c.bodies[id], r = sub(this.s.r, body), v = sub(this.s.v, { x: body.vx, y: body.vy, z: body.vz || 0 }), distance = length(r), speed = length(v), mu = this.c.G * physical.mass, energy = speed * speed / 2 - mu / distance, semiMajor = -mu / (2 * energy), eccentricity = length(mul(sub(mul(r, speed * speed - mu / distance), mul(v, dot(r, v))), 1 / mu));
      return { body: id, alt: distance - physical.radius_m, distance, speed, radial: dot(r, v) / distance, a: semiMajor, e: eccentricity, peri: semiMajor * (1 - eccentricity), apo: eccentricity < 1 ? semiMajor * (1 + eccentricity) : Infinity, target: target && bodies[target] ? length(sub(this.s.r, bodies[target])) : 0 };
    }
    propellantForDeltaV(deltaV) {
      if (!(deltaV > 0)) return 0;
      return this.s.m * (1 - Math.exp(-deltaV / (this.specificImpulse * 9.80665)));
    }
    serialize() {
      return {
        s: { ...this.s },
        stages: this.stages.map(st => ({ ...st })),
        currentStage: this.currentStage,
        ascentMode: this.ascentMode,
        landed: this.s.landed,
        landedBody: this.landedBody,
        landedDir: this.landedDir ? { ...this.landedDir } : null,
        circularHold: this.circularHold ? { ...this.circularHold } : null,
        coast: this.coast ? { ...this.coast } : null,
        reentryState: { ...this.reentryState },
        infiniteFuel: this.infiniteFuel,
        progradeLock: this.progradeLock,
        steerOverride: this.steerOverride,
        manualSteer: this.manualSteer,
        prevThrottle: this.prevThrottle,
        payloadMass: this.payloadMass
      };
    }
    deserialize(data) {
      if (!data) return;
      this.s = { ...data.s };
      // v0.1.2: pre-v0.1.2 saves carry none of the thermal/chute fields —
      // backfill them to pad-fresh defaults so temperature math, shield and
      // chute reads never see undefined/NaN on a loaded game.
      if (!Number.isFinite(this.s.temperature)) this.s.temperature = AMBIENT_K;
      if (!Number.isFinite(this.s.heatDamage)) this.s.heatDamage = 0;
      if (typeof this.s.chuteDeployed !== 'boolean') this.s.chuteDeployed = false;
      if (typeof this.s.chuteAlive !== 'boolean') this.s.chuteAlive = false;
      if (typeof this.s.shieldFacing !== 'boolean') this.s.shieldFacing = false;
      this.stages = (data.stages || []).map(st => ({ ...st }));
      this.currentStage = data.currentStage || 0;
      this.ascentMode = data.ascentMode || false;
      this.landedBody = data.landedBody || null;
      this.landedDir = data.landedDir ? { ...data.landedDir } : null;
      this.circularHold = data.circularHold ? { ...data.circularHold } : null;
      this.coast = data.coast ? { ...data.coast } : null;
      this.reentryState = data.reentryState ? { ...data.reentryState } : { bodyId: null, phase: 'EXO', q: 0, rho: 0, heating: 0, gLoad: 0, alt: 0, peakHeating: 0, peakG: 0 };
      this.infiniteFuel = data.infiniteFuel || false;
      this.progradeLock = data.progradeLock !== undefined ? data.progradeLock : true;
      this.steerOverride = data.steerOverride || false;
      this.manualSteer = data.manualSteer || false;
      this.prevThrottle = data.prevThrottle || 0;
      this.payloadMass = data.payloadMass || 50;
      this.updateStageProperties();
      // updateStageProperties seeds s.m from the ACTIVE stage's nominal
      // propellant; a save carries the real remaining amount, so restore it
      // AFTER mass is rebuilt. Without this a loaded pad save starts at 0
      // propellant and can never reach TWR > 1 to lift off.
      if (data.s && Number.isFinite(data.s.propellant)) {
        this.s.propellant = Math.max(0, data.s.propellant);
        this.s.m = this.dryMass + this.s.propellant + this.payloadMass;
      }
    }
  }
  return { Flight, rk4Step, aeroAccel, atmosphericDrag, atmosphereDensity, atmosphereStepLimit, isSolidSurface, atmospheres: ATMOSPHERES, add, sub, mul, dot, length };
})();
