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
    // Visual/simulation envelopes use real-world relative heights. Density is
    // exponential, so this is meaningful drag rather than a hard wall.
    earth: { top: 100000, rho0: 1.225, scaleHeight: 8500 },
    venus: { top: 250000, rho0: 65, scaleHeight: 15900 },
    mars: { top: 125000, rho0: .020, scaleHeight: 11100 },
    'saturn:titan': { top: 600000, rho0: 5.3, scaleHeight: 40000 }
  };
  const DRAG_AREA = 3;
  function atmosphereDensity(position, body, physical) {
    const atmosphere = ATMOSPHERES[physical.id];
    if (!atmosphere) return null;
    const altitude = length(sub(position, body)) - physical.radius_m;
    if (!(altitude >= 0 && altitude < atmosphere.top)) return null;
    return atmosphere.rho0 * Math.exp(-altitude / atmosphere.scaleHeight);
  }
  function atmosphericDrag(position, velocity, body, physical, mass) {
    const rho = atmosphereDensity(position, body, physical);
    if (!rho) return { x: 0, y: 0, z: 0 };
    const v = sub(velocity, { x: body.vx || 0, y: body.vy || 0, z: body.vz || 0 }), speed = length(v);
    if (!(speed > 0)) return { x: 0, y: 0, z: 0 };
    return mul(v, -.5 * rho * DRAG_AREA * speed / Math.max(mass, 1));
  }
  function atmosphereStepLimit(position, velocity, bodies, constants, mass) {
    let limit = Infinity;
    for (const [id, body] of Object.entries(bodies)) {
      const physical = constants.bodies[id]; if (!physical) continue;
      const rho = atmosphereDensity(position, body, { ...physical, id });
      if (!rho) continue;
      const speed = length(sub(velocity, { x: body.vx || 0, y: body.vy || 0, z: body.vz || 0 }));
      if (!(speed > 1)) continue;
      // τ = v/a_drag = 2m/(ρ CdA v). Resolve each decay time with >= 24
      // RK stages; cap avoids a needlessly tiny step in the upper atmosphere.
      const decayTime = 2 * Math.max(mass, 1) / (rho * DRAG_AREA * speed);
      limit = Math.min(limit, Math.max(.002, Math.min(2, decayTime / 24)));
    }
    return limit;
  }
  class Flight {
    constructor(constants) {
      this.c = constants;
      this.thrust = 20000;
      this.specificImpulse = 320;
      this.dryMass = 500;
      this.infiniteFuel = false;
      this.circularHold = null;
      this.progradeLock = true;   // powered flight tracks orbital prograde unless overridden
      this.steerOverride = false; // set by auto-burn while it owns the heading
      this.manualSteer = false;   // set by app while turn keys are held
      this.coast = null;          // analytic on-rails coast arc (patched conic), or null
      this.prevThrottle = 0;
      this.s = { r: { x: 0, y: 0, z: 0 }, v: { x: 0, y: 0, z: 0 }, m: 1000, propellant: 500, heading: 0, throttle: 0, crashed: false };
    }
    launch(id, bodies) {
      const body = bodies[id], physical = this.c.bodies[id], radius = physical.radius_m + 180000, speed = Math.sqrt(this.c.G * physical.mass / radius);
      this.s = { r: { x: body.x, y: body.y + radius, z: body.z || 0 }, v: { x: body.vx - speed, y: body.vy, z: body.vz || 0 }, m: 1000, propellant: 500, heading: Math.PI, throttle: 0, crashed: false };
      this.circularHold = { id, radius, phase: Math.PI / 2, meanMotion: speed / radius };
      this.coast = null; this.prevThrottle = 0;
    }
    advanceCircularHold(seconds, bodies) {
      const hold = this.circularHold, body = bodies[hold.id], physical = this.c.bodies[hold.id];
      if (!body || !physical) { this.circularHold = null; return false; }
      hold.phase += hold.meanMotion * seconds;
      const host = this.bodyAt(body, seconds), cos = Math.cos(hold.phase), sin = Math.sin(hold.phase), radius = hold.radius, speed = hold.meanMotion * radius;
      this.s.r = { x: host.x + radius * cos, y: host.y + radius * sin, z: host.z || 0 };
      this.s.v = { x: (body.vx || 0) - speed * sin, y: (body.vy || 0) + speed * cos, z: body.vz || 0 };
      return true;
    }
    syncCircularHold(bodies) {
      if (!this.circularHold) return;
      const hold = this.circularHold, body = bodies[hold.id]; if (!body) return;
      const cos = Math.cos(hold.phase), sin = Math.sin(hold.phase), speed = hold.meanMotion * hold.radius;
      this.s.r = { x: body.x + hold.radius * cos, y: body.y + hold.radius * sin, z: body.z || 0 };
      this.s.v = { x: (body.vx || 0) - speed * sin, y: (body.vy || 0) + speed * cos, z: body.vz || 0 };
    }
    bodyAt(body, time) { return { x: body.x + (body.vx || 0) * time, y: body.y + (body.vy || 0) * time, z: (body.z || 0) + (body.vz || 0) * time }; }
    progradeHeading(bodies, state = this.s) {
      const id = this.dominant(bodies, state), body = bodies[id];
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
      const id = this.dominant(bodies, s), body = bodies[id], physical = this.c.bodies[id];
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
      let remaining = seconds;
      let elapsed = 0;
      while (remaining > 1e-9) {
        const dt = Math.min(10, remaining);
        elapsed += dt;
        const body = bodies[c.body];
        if (!body) { this.coast = null; return false; }
        if (this.dominant(bodies, this.s) !== c.body) { this.coast = null; return false; }
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
        const bp = this.bodyAt(body, elapsed);
        const bvx = body.vx || 0, bvy = body.vy || 0, bvz = body.vz || 0;
        this.s.r = { x: bp.x + ox * c.Px + oy * c.Qx, y: bp.y + ox * c.Py + oy * c.Qy, z: (bp.z || 0) + ox * c.Pz + oy * c.Qz };
        this.s.v = { x: bvx + ovx * c.Px + ovy * c.Qx, y: bvy + ovx * c.Py + ovy * c.Qy, z: bvz + ovx * c.Pz + ovy * c.Qz };
        for (const [bid, b] of Object.entries(bodies)) {
          const p = this.c.bodies[bid]; if (!p) continue;
          if (length(sub(this.s.r, this.bodyAt(b, elapsed))) < p.radius_m) { this.s.crashed = true; this.s.throttle = 0; this.coast = null; return true; }
        }
        const atm = ATMOSPHERES[c.body];
        if (atm && R1 - c.radius < atm.top) { this.coast = null; return false; }
        remaining -= dt;
      }
      return true;
    }
    acc(position, bodies, time = 0, velocity = this.s.v) {
      let acceleration = { x: 0, y: 0, z: 0 };
      for (const [id, initial] of Object.entries(bodies)) {
        const physical = this.c.bodies[id]; if (!physical) continue;
        const displacement = sub(position, this.bodyAt(initial, time)), squared = dot(displacement, displacement);
        if (squared <= 1) continue;
        acceleration = add(acceleration, mul(displacement, -this.c.G * physical.mass / (squared * Math.sqrt(squared))));
        acceleration = add(acceleration, atmosphericDrag(position, velocity, this.bodyAt(initial, time), { ...physical, id }, this.s.m));
      }
      const usableThrottle = (this.infiniteFuel || this.s.propellant > 0) && !this.s.crashed ? this.s.throttle : 0;
      const safeMass = Math.max(this.s.m, 1);
      return add(acceleration, mul({ x: Math.cos(this.s.heading), y: Math.sin(this.s.heading), z: 0 }, this.thrust * usableThrottle / safeMass));
    }
    rk4(dt, bodies, time) {
      const state = this.s;
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
    dominant(bodies, state = this.s) { let id = 'sun', greatest = 0; for (const [key, body] of Object.entries(bodies)) { const physical = this.c.bodies[key]; if (!physical) continue; const distance = length(sub(state.r, body)), pull = this.c.G * physical.mass / (distance * distance); if (pull > greatest) { greatest = pull; id = key; } } return id; }
    maximumStep(bodies, state = this.s) {
      const id = this.dominant(bodies, state), body = bodies[id], physical = this.c.bodies[id], radius = length(sub(state.r, body)), period = 2 * Math.PI * Math.sqrt(radius ** 3 / (this.c.G * physical.mass));
      // A tighter orbital step keeps osculating PE/AP stable after a coast or
      // burn, particularly while the craft is close to its SOI primary.
      const orbitalLimit = Math.max(.125, Math.min(180, period / 2400));
      return Math.min(orbitalLimit, atmosphereStepLimit(state.r, state.v, bodies, this.c, state.m));
    }
    step(seconds, bodies) {
      if (!seconds || this.s.crashed) return;
      if (this.s.throttle > 0) { this.circularHold = null; this.coast = null; }
      // Prograde lock tracks the orbit as it curves, re-snapping every RK4
      // substep so long high-warp frames can't go stale mid-burn.
      const lock = this.progradeLock && !this.steerOverride && !this.manualSteer && this.s.throttle > 0 && !this.s.crashed;
      const lockId = lock ? this.dominant(bodies, this.s) : null;
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
        this.rk4(dt, bodies, index * dt); for (const [id, body] of Object.entries(bodies)) { const physical = this.c.bodies[id]; if (physical && length(sub(this.s.r, this.bodyAt(body, (index + 1) * dt))) < physical.radius_m) { this.s.crashed = true; this.s.throttle = 0; return; } }
      }
      this.prevThrottle = this.s.throttle;
    }
    diagnostics(bodies, target) {
      const id = this.dominant(bodies), body = bodies[id], physical = this.c.bodies[id], r = sub(this.s.r, body), v = sub(this.s.v, { x: body.vx, y: body.vy, z: body.vz || 0 }), distance = length(r), speed = length(v), mu = this.c.G * physical.mass, energy = speed * speed / 2 - mu / distance, semiMajor = -mu / (2 * energy), eccentricity = length(mul(sub(mul(r, speed * speed - mu / distance), mul(v, dot(r, v))), 1 / mu));
      return { body: id, alt: distance - physical.radius_m, distance, speed, radial: dot(r, v) / distance, a: semiMajor, e: eccentricity, peri: semiMajor * (1 - eccentricity), apo: eccentricity < 1 ? semiMajor * (1 + eccentricity) : Infinity, target: target && bodies[target] ? length(sub(this.s.r, bodies[target])) : 0 };
    }
    propellantForDeltaV(deltaV) {
      if (!(deltaV > 0)) return 0;
      return this.s.m * (1 - Math.exp(-deltaV / (this.specificImpulse * 9.80665)));
    }
  }
  return { Flight, rk4Step, atmosphericDrag, atmosphereDensity, atmosphereStepLimit, atmospheres: ATMOSPHERES, add, sub, mul, dot, length };
})();
