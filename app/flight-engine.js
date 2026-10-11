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
  function atmosphericDrag(position, velocity, body, physical, mass) {
    const rho = atmosphereDensity(position, body, physical);
    if (!rho) return { x: 0, y: 0, z: 0 };
    const v = sub(velocity, { x: body.vx || 0, y: body.vy || 0, z: body.vz || 0 }), speed = length(v);
    if (!(speed > 0)) return { x: 0, y: 0, z: 0 };
    // Drag acceleration opposite to relative velocity vector
    return mul(v, -0.5 * rho * DRAG_CD * DRAG_AREA * speed / Math.max(mass, 1));
  }
  function atmosphereStepLimit(position, velocity, bodies, constants, mass) {
    let limit = Infinity;
    for (const [id, body] of Object.entries(bodies)) {
      const physical = constants.bodies[id]; if (!physical) continue;
      if (!ATMOSPHERES[id]) continue;
      const rho = atmosphereDensity(position, body, { ...physical, id });
      // Only meaningful once the air is dense enough to bite; above that, cap
      // the step by sqrt(m / (0.5·ρ·Cd·A·|v|)) · 0.5 so a reentry can never
      // outrun the integrator at high warp.
      if (!rho || rho <= 1e-4) continue;
      const speed = length(sub(velocity, { x: body.vx || 0, y: body.vy || 0, z: body.vz || 0 }));
      if (!(speed > 1)) continue;
      const decay = 0.5 * rho * DRAG_CD * DRAG_AREA * speed;   // force per unit velocity
      const cap = Math.sqrt(Math.max(mass, 1) / Math.max(decay, 1e-12)) * 0.5;
      limit = Math.min(limit, Math.max(.002, Math.min(300, cap)));
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
      this.s = { r: { x: 0, y: 0, z: 0 }, v: { x: 0, y: 0, z: 0 }, m: 0, propellant: 0, heading: 0, throttle: 0, crashed: false, landed: false };
      // Reentry tracking state (per dominant body)
      this.reentryState = { bodyId: null, phase: 'EXO', q: 0, rho: 0, heating: 0, gLoad: 0, alt: 0, peakHeating: 0, peakG: 0 };
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
      // Initialize default stages if not already set
      if (!this.stages.length) {
        this.stages = [
          { id: 0, dryMass: 400, propellant: 400, thrust: 25000, isp: 290 },
          { id: 1, dryMass: 100, propellant: 100, thrust: 5000, isp: 350 }
        ];
        this.currentStage = 0;
        this.updateStageProperties();
      }
      this.ascentMode = false;
      const body = bodies[id], physical = this.c.bodies[id];
      const atmosphere = ATMOSPHERES[id];
      // Start above the air where there is one (plus a lift margin), else well
      // clear of the ground. Sets the circular-hold radius directly.
      const radius = physical.radius_m + (atmosphere ? atmosphere.top + 20000 : 180000);
      const speed = Math.sqrt(this.c.G * physical.mass / radius);
      this.s = { r: { x: body.x, y: body.y + radius, z: body.z || 0 }, v: { x: body.vx - speed, y: body.vy, z: body.vz || 0 }, m: this.s.m, propellant: this.s.propellant, heading: Math.PI, throttle: 0, crashed: false, landed: false };
      this.circularHold = { id, radius, phase: Math.PI / 2, meanMotion: speed / radius };
      this.coast = null; this.prevThrottle = 0;
      this.landedBody = null; this.landedDir = null;
      // Reset reentry state on launch
      this.reentryState = { bodyId: null, phase: 'EXO', q: 0, rho: 0, heating: 0, gLoad: 0, alt: 0, peakHeating: 0, peakG: 0 };
    }

    // Staging: drop the previous stage's dry mass and remaining propellant
    stage() {
      if (this.currentStage >= this.stages.length - 1) {
        console.info('[stage] No more stages');
        return;
      }
      const prevStage = this.stages[this.currentStage];
      const deadMass = prevStage.dryMass + prevStage.propellant;
      this.currentStage++;
      this.updateStageProperties();
      console.info(`[stage] Stage separation: dropped ${deadMass} kg, now stage ${this.currentStage} (thrust=${this.thrust} N, isp=${this.specificImpulse} s, mass=${this.s.m} kg)`);
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
        const apoapsis = hyp ? Infinity : a * (1 + e);
        if (apoapsis > soi) return false;
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
      this.coast = { body: id, mu, a, e, hyp, Px, Py, Pz, Qx, Qy, Qz, n, M, E: E0, radius: physical.radius_m };
      return true;
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
          if (p.solidSurface && length(sub(this.s.r, this.bodyAt(b, elapsed, accels, bid))) < p.radius_m) { this.s.crashed = true; this.s.throttle = 0; this.coast = null; return true; }
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
        acceleration = add(acceleration, atmosphericDrag(position, velocity, at, { ...physical, id }, this.s.m));
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
      if (!this.infiniteFuel) {
        const burn = this.thrust * Math.max(0, state.throttle) / (this.specificImpulse * 9.80665) * dt;
        const used = Math.min(state.propellant, burn); state.propellant -= used; state.m = this.dryMass + state.propellant;
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
      return Math.min(orbitalLimit, atmosphereStepLimit(state.r, state.v, bodies, this.c, state.m));
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
        if (this.s.throttle > 0 && body && physical) {
          // Compute TWR = thrust * throttle / (mass * local_g)
          const local_g = this.c.G * physical.mass / (physical.radius_m * physical.radius_m);
          const twr = (this.thrust * this.s.throttle) / (this.s.m * local_g);
          if (twr > 1.0) {
            // TWR > 1: liftoff! Un-pin and transition to flying
            this.s.landed = false;
            this.landedBody = null;
            this.landedDir = null;
            console.info(`[liftoff] TWR=${twr.toFixed(2)} > 1.0, transitioning to flight`);
          } else {
            // TWR <= 1: stay pinned, consume fuel/heat, v = body velocity
            this.s.r = { x: body.x + this.landedDir.x * physical.radius_m, y: body.y + this.landedDir.y * physical.radius_m, z: (body.z || 0) + this.landedDir.z * physical.radius_m };
            this.s.v = { x: body.vx || 0, y: body.vy || 0, z: body.vz || 0 };
            this.prevThrottle = this.s.throttle;
            return; // Skip physics integration, but fuel still burns in rk4
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
          // Surface normal heading (straight up)
          const surfaceNormalHeading = Math.atan2(rel.y, rel.x) - Math.PI / 2;
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
          const maxPitchRate = 0.0873;
          let angleToTarget = targetHeading - this.s.heading;
          angleToTarget = Math.atan2(Math.sin(angleToTarget), Math.cos(angleToTarget));
          const limitedAngle = Math.max(-maxPitchRate, Math.min(maxPitchRate, angleToTarget));
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
      const lock = this.progradeLock && !this.steerOverride && !this.manualSteer && this.s.throttle > 0 && !this.s.crashed;
      const lockId = lock ? this.referenceBody(bodies, this.s) : null;
      const lockBody = lock && lockId ? bodies[lockId] : null;
      const powered = this.s.throttle > 0;
      if (!powered && !this.circularHold && !this.coast && !this.s.crashed) this.captureCoast(bodies);
      if (this.coast && !powered && !this.s.crashed) {
        const ok = this.advanceCoast(seconds, bodies);
        this.prevThrottle = this.s.throttle;
        if (!ok && !this.s.crashed) { this.coast = null; this.captureCoast(bodies); }
        return;
      }
      if (this.circularHold && this.s.throttle === 0) { this.advanceCircularHold(seconds, bodies); this.prevThrottle = this.s.throttle; return; }
      const step = this.maximumStep(bodies), count = Math.max(1, Math.ceil(seconds / step)), dt = seconds / count;
      for (let index = 0; index < count; index++) {
        if (lockBody) {
          const lvx = this.s.v.x - (lockBody.vx || 0), lvy = this.s.v.y - (lockBody.vy || 0);
          if (Math.hypot(lvx, lvy) > 1e-9) this.s.heading = Math.atan2(lvy, lvx);
        }
        this.rk4(dt, bodies, index * dt);
        if (this.resolveContacts(bodies, (index + 1) * dt)) break;
      }

      // --- Reentry phase tracking (per dominant body) ---
      const refId = this.referenceBody(bodies, this.s);
      const refBody = bodies[refId];
      const refPhysical = this.c.bodies[refId];
      if (refBody && refPhysical) {
        const atm = ATMOSPHERES[refId];
        const rel = sub(this.s.r, refBody);
        const distance = length(rel);
        const altitude = distance - refPhysical.radius_m;
        const vRel = length(sub(this.s.v, { x: refBody.vx || 0, y: refBody.vy || 0, z: refBody.vz || 0 }));
        const rho = atm ? (atmosphereDensity(this.s.r, refBody, { ...refPhysical, id: refId }) || 0) : 0;

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
    }
  }
  return { Flight, rk4Step, atmosphericDrag, atmosphereDensity, atmosphereStepLimit, isSolidSurface, atmospheres: ATMOSPHERES, add, sub, mul, dot, length };
})();
