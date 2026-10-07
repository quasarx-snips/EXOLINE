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
      this.s = { r: { x: 0, y: 0, z: 0 }, v: { x: 0, y: 0, z: 0 }, m: 1000, propellant: 500, heading: 0, throttle: 0, crashed: false };
    }
    launch(id, bodies) {
      const body = bodies[id], physical = this.c.bodies[id], radius = physical.radius_m + 180000, speed = Math.sqrt(this.c.G * physical.mass / radius);
      this.s = { r: { x: body.x, y: body.y + radius, z: body.z || 0 }, v: { x: body.vx - speed, y: body.vy, z: body.vz || 0 }, m: 1000, propellant: 500, heading: -Math.PI / 2, throttle: 0, crashed: false };
      this.circularHold = { id, radius, phase: Math.PI / 2, meanMotion: speed / radius };
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
      return add(acceleration, mul({ x: Math.cos(this.s.heading), y: Math.sin(this.s.heading), z: 0 }, this.thrust * usableThrottle / this.s.m));
    }
    rk4(dt, bodies, time) {
      const state = this.s;
      rk4Step(state, dt, (r, offset, v) => this.acc(r, bodies, time + offset, v));
      if (!this.infiniteFuel) {
        const burn = this.thrust * Math.max(0, state.throttle) / (this.specificImpulse * 9.80665) * dt;
        const used = Math.min(state.propellant, burn); state.propellant -= used; state.m = this.dryMass + state.propellant;
        if (used < burn) state.throttle = 0;
      }
      if (!Number.isFinite(state.r.x) || !Number.isFinite(state.v.x)) throw Error('Invalid flight state');
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
      if (this.s.throttle > 0) this.circularHold = null;
      if (this.circularHold && this.s.throttle === 0) { this.advanceCircularHold(seconds, bodies); return; }
      const step = this.maximumStep(bodies), count = Math.max(1, Math.ceil(seconds / step)), dt = seconds / count;
      for (let index = 0; index < count; index++) { this.rk4(dt, bodies, index * dt); for (const [id, body] of Object.entries(bodies)) { const physical = this.c.bodies[id]; if (physical && length(sub(this.s.r, this.bodyAt(body, (index + 1) * dt))) < physical.radius_m) { this.s.crashed = true; this.s.throttle = 0; return; } } }
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
