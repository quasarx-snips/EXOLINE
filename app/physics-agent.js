window.ExolinePhysicsAgent = (() => {
  const enabled = true;
  const violations = [];
  const MAX_VIOLATIONS = 200;

  let lastEpsilon = null;
  let lastH = null;
  let lastThrottle = 0;
  let warpStabilityDone = false;
  let warpStabilityStartState = null;
  let warpStabilityStartTime = 0;
  let lastCheckFrame = 0;

  function check(frameCount, flight, bodies) {
    if (!enabled) return;
    lastCheckFrame = frameCount;
    if (frameCount % 10 === 0) lightChecks(flight, bodies);
    if (frameCount % 60 === 0) deepChecks(flight, bodies);
  }

  function lightChecks(flight, bodies) {
    const s = flight.s;
    const stateKeys = ['r.x', 'r.y', 'r.z', 'v.x', 'v.y', 'v.z', 'm', 'propellant'];
    const stateValues = [s.r.x, s.r.y, s.r.z, s.v.x, s.v.y, s.v.z, s.m, s.propellant];
    for (let i = 0; i < stateKeys.length; i++) {
      if (!Number.isFinite(stateValues[i])) {
        logViolation('StateFiniteness', 'CRITICAL', `State ${stateKeys[i]} is not finite`, 'finite number', stateValues[i]);
      }
    }

    if (!(s.m > 0)) {
      logViolation('MassPositivity', 'CRITICAL', 'Total mass must be positive', '> 0', s.m);
    }
    if (!(s.propellant >= 0)) {
      logViolation('MassPositivity', 'CRITICAL', 'Propellant must be non-negative', '>= 0', s.propellant);
    }
    if (!(s.m >= flight.dryMass)) {
      logViolation('MassPositivity', 'CRITICAL', 'Total mass must be >= dryMass', `>= ${flight.dryMass}`, s.m);
    }

    if (!(s.throttle >= 0 && s.throttle <= 1)) {
      logViolation('ThrottleRange', 'WARNING', 'Throttle out of range [0, 1]', '0 <= throttle <= 1', s.throttle);
    }

    if (s.crashed) {
      if (s.throttle !== 0) {
        logViolation('CrashStateConsistency', 'WARNING', 'Crashed craft has non-zero throttle', 'throttle = 0', s.throttle);
      }
    }

    if (flight.circularHold) {
      if (s.throttle !== 0) {
        logViolation('CircularHoldConsistency', 'WARNING', 'Circular hold active but throttle != 0', 'throttle = 0', s.throttle);
      }
      const hold = flight.circularHold;
      const body = bodies[hold.id];
      if (body) {
        const dx = s.r.x - body.x;
        const dy = s.r.y - body.y;
        const dist = Math.hypot(dx, dy);
        if (Math.abs(dist - hold.radius) > 100) {
          logViolation('CircularHoldConsistency', 'WARNING', 'Distance from hold body differs from hold radius', `~${hold.radius}`, dist);
        }
        let mu = 6.67430e-11 * 5.97219e24;
        if (flight.c && flight.c.bodies && flight.c.bodies[hold.id]) {
          mu = flight.c.G * flight.c.bodies[hold.id].mass;
        }
        const expectedSpeed = Math.sqrt(mu / hold.radius);
        const speed = Math.hypot(s.v.x - body.vx, s.v.y - body.vy);
        if (Math.abs(speed - expectedSpeed) > 1) {
          logViolation('CircularHoldConsistency', 'WARNING', 'Speed differs from circular orbit speed', `~${expectedSpeed}`, speed);
        }
      }
    }
  }

  function deepChecks(flight, bodies) {
    checkVisViva(flight, bodies);
    checkEnergyConservation(flight, bodies);
    checkAngularMomentumConservation(flight, bodies);
    checkSOIRadius(flight, bodies);
    checkRocketEquation(flight);
    checkFuelConsumptionRate(flight);
    checkTWRSanity(flight, bodies);
    checkAtmosphereModel(bodies);
    checkDragDirection(flight, bodies);
    checkKeplerSolver();
    checkRK4Order(flight, bodies);
    checkCollisionBoundary(flight, bodies);
    checkWarpStability(flight, bodies);
    checkNavigationPrediction(flight, bodies);
    checkBodyEphemeris(bodies);
  }

  function checkVisViva(flight, bodies) {
    const s = flight.s;
    const diag = flight.diagnostics(bodies);
    const dominantId = diag.body;
    const dominantBody = bodies[dominantId];
    if (!dominantBody) return;
    const physical = window.ExolineFlight ? window.ExolineFlight : null;
    const constants = physical ? { G: 6.67430e-11 } : { G: 6.67430e-11 };
    // Get mu from the flight engine's constants
    let mu = 6.67430e-11 * 5.97219e24; // fallback to Earth
    if (flight.c && flight.c.bodies && flight.c.bodies[dominantId]) {
      mu = flight.c.G * flight.c.bodies[dominantId].mass;
    }
    const r = Math.hypot(s.r.x - dominantBody.x, s.r.y - dominantBody.y);
    const vRelX = s.v.x - (dominantBody.vx || 0);
    const vRelY = s.v.y - (dominantBody.vy || 0);
    const vSquared = vRelX * vRelX + vRelY * vRelY;
    const a = diag.a;
    if (!Number.isFinite(a) || a <= 0) return;
    const expected = mu * (2 / r - 1 / a);
    if (diag.e >= 1) {
      if (vSquared / 2 - mu / r <= 0) {
        logViolation('VisVivaEquation', 'CRITICAL', 'Hyperbolic orbit should have positive energy', 'energy > 0', vSquared / 2 - mu / r);
      }
    } else {
      const relError = Math.abs(vSquared - expected) / Math.abs(expected);
      if (relError > 1e-4) {
        logViolation('VisVivaEquation', 'WARNING', 'Vis-viva equation violated', `rel error < 1e-4`, relError.toExponential(3));
      }
    }
  }

  function checkEnergyConservation(flight, bodies) {
    const s = flight.s;
    if (s.throttle === 0 && !flight.circularHold) {
      const diag = flight.diagnostics(bodies);
      const dominantId = diag.body;
      const dominantBody = bodies[dominantId];
      if (!dominantBody) return;
      let mu = 6.67430e-11 * 5.97219e24;
      if (flight.c && flight.c.bodies && flight.c.bodies[dominantId]) {
        mu = flight.c.G * flight.c.bodies[dominantId].mass;
      }
      const r = Math.hypot(s.r.x - dominantBody.x, s.r.y - dominantBody.y);
      const vRelX = s.v.x - (dominantBody.vx || 0);
      const vRelY = s.v.y - (dominantBody.vy || 0);
      const vSquared = vRelX * vRelX + vRelY * vRelY;
      const epsilon = vSquared / 2 - mu / r;
      if (lastEpsilon !== null && lastThrottle === 0) {
        const relError = Math.abs(epsilon - lastEpsilon) / Math.abs(lastEpsilon);
        if (relError > 1e-6) {
          logViolation('EnergyConservation', 'WARNING', 'Specific orbital energy not conserved during coast', 'rel error < 1e-6', relError.toExponential(3));
        }
      }
      lastEpsilon = epsilon;
    } else {
      lastEpsilon = null;
    }
    lastThrottle = s.throttle;
  }

  function checkAngularMomentumConservation(flight, bodies) {
    const s = flight.s;
    if (s.throttle === 0) {
      const diag = flight.diagnostics(bodies);
      const dominantId = diag.body;
      const dominantBody = bodies[dominantId];
      if (!dominantBody) return;
      const rx = s.r.x - dominantBody.x;
      const ry = s.r.y - dominantBody.y;
      const vx = s.v.x - (dominantBody.vx || 0);
      const vy = s.v.y - (dominantBody.vy || 0);
      const h = rx * vy - ry * vx;
      if (lastH !== null && lastThrottle === 0) {
        const relError = Math.abs(h - lastH) / Math.abs(lastH);
        if (relError > 1e-6) {
          logViolation('AngularMomentumConservation', 'WARNING', 'Angular momentum not conserved during coast', 'rel error < 1e-6', relError.toExponential(3));
        }
      }
      lastH = h;
    } else {
      lastH = null;
    }
  }

  function checkSOIRadius(flight, bodies) {
    const diag = flight.diagnostics(bodies);
    const dominantId = diag.body;
    if (dominantId === 'sun') return;
    const physical = flight.c && flight.c.bodies ? flight.c.bodies[dominantId] : null;
    const parentId = physical && physical.parent ? physical.parent : 'sun';
    const parent = flight.c && flight.c.bodies ? flight.c.bodies[parentId] : null;
    if (!physical || !parent) return;
    const orbit = window.ExolineOrbit.state(dominantId, new Date());
    if (!orbit || !Number.isFinite(orbit.a)) return;
    const a = orbit.a * 149597870700;
    const expectedSOI = a * Math.pow(physical.mass / parent.mass, 0.4);
    const navSOI = window.ExolineNav?.soiRadius(dominantId);
    if (navSOI && Number.isFinite(navSOI)) {
      const relError = Math.abs(navSOI - expectedSOI) / expectedSOI;
      if (relError > 0.02) {
        logViolation('SOIRadiusValidation', 'WARNING', 'SOI radius differs from Laplace formula', 'rel error < 0.02', relError.toFixed(4));
      }
    }
  }

  function checkRocketEquation(flight) {
    for (const dv of [100, 1000, 5000]) {
      const prop = flight.propellantForDeltaV(dv);
      if (prop <= 0) continue;
      const m0 = flight.s.m;
      const mf = m0 - prop;
      const dvCheck = flight.specificImpulse * 9.80665 * Math.log(m0 / mf);
      const relError = Math.abs(dvCheck - dv) / dv;
      if (relError > 1e-6) {
        logViolation('RocketEquationValidation', 'WARNING', 'Rocket equation inverse check failed', 'rel error < 1e-6', relError.toExponential(3));
      }
    }
  }

  function checkFuelConsumptionRate(flight) {
    const s = flight.s;
    if (s.throttle > 0 && s.propellant > 0) {
      const mDot = flight.thrust / (flight.specificImpulse * 9.80665);
      const dt = 1;
      const expectedUsage = mDot * dt;
      logViolation('FuelConsumptionRate', 'INFO', 'Fuel flow check (placeholder)', 'placeholder', 'placeholder');
    }
  }

  function checkTWRSanity(flight, bodies) {
    const earthBody = bodies.earth;
    if (!earthBody) return;
    let G = 6.67430e-11;
    let earthMass = 5.97219e24;
    let earthRadius = 6371000;
    if (flight.c && flight.c.bodies && flight.c.bodies.earth) {
      G = flight.c.G;
      earthMass = flight.c.bodies.earth.mass;
      earthRadius = flight.c.bodies.earth.radius_m;
    }
    const surfaceG = G * earthMass / (earthRadius * earthRadius);
    const twr = flight.thrust / (flight.s.m * surfaceG);
    if (twr <= 1) {
      logViolation('TWRSanity', 'WARNING', 'TWR <= 1, craft cannot lift off from Earth', 'TWR > 1', twr.toFixed(3));
    }
  }

  function checkAtmosphereModel(bodies) {
    if (!window.ExolineFlight || !window.ExolineFlight.atmospheres) return;
    for (const [id, atm] of Object.entries(window.ExolineFlight.atmospheres)) {
      if (atm.rho0 <= 0) {
        logViolation('AtmosphereModel', 'WARNING', `Atmosphere ${id}: surface density must be positive`, 'rho0 > 0', atm.rho0);
      }
      if (atm.scaleHeight <= 0) {
        logViolation('AtmosphereModel', 'WARNING', `Atmosphere ${id}: scale height must be positive`, 'scaleHeight > 0', atm.scaleHeight);
      }
      if (atm.top <= atm.scaleHeight) {
        logViolation('AtmosphereModel', 'WARNING', `Atmosphere ${id}: top should be > scaleHeight`, 'top > scaleHeight', `${atm.top} <= ${atm.scaleHeight}`);
      }
    }
  }

  function checkDragDirection(flight, bodies) {
    const s = flight.s;
    const diag = flight.diagnostics(bodies);
    const dominantId = diag.body;
    const dominantBody = bodies[dominantId];
    if (!dominantBody) return;
    const vRelX = s.v.x - (dominantBody.vx || 0);
    const vRelY = s.v.y - (dominantBody.vy || 0);
    if (!window.ExolineFlight || !window.ExolineFlight.atmosphericDrag) return;
    const physical = flight.c && flight.c.bodies ? flight.c.bodies[dominantId] : { radius_m: 6371000 };
    const drag = window.ExolineFlight.atmosphericDrag(s.r, s.v, dominantBody, { id: dominantId, radius_m: physical.radius_m || 6371000 }, s.m);
    const dot = drag.x * vRelX + drag.y * vRelY;
    if (dot > 0) {
      logViolation('DragDirection', 'CRITICAL', 'Drag force is not opposing velocity', 'drag dot v <= 0', dot);
    }
  }

  function checkKeplerSolver() {
    const testCases = [
      { e: 0, M: 0 }, { e: 0.3, M: 0 }, { e: 0.5, M: 0 }, { e: 0.7, M: 0 }, { e: 0.9, M: 0 }, { e: 0.99, M: 0 },
      { e: 0, M: Math.PI/2 }, { e: 0.3, M: Math.PI/2 }, { e: 0.5, M: Math.PI/2 }, { e: 0.7, M: Math.PI/2 }, { e: 0.9, M: Math.PI/2 }, { e: 0.99, M: Math.PI/2 },
      { e: 0, M: Math.PI }, { e: 0.3, M: Math.PI }, { e: 0.5, M: Math.PI }, { e: 0.7, M: Math.PI }, { e: 0.9, M: Math.PI }, { e: 0.99, M: Math.PI },
      { e: 0, M: 3*Math.PI/2 }, { e: 0.3, M: 3*Math.PI/2 }, { e: 0.5, M: 3*Math.PI/2 }, { e: 0.7, M: 3*Math.PI/2 }, { e: 0.9, M: 3*Math.PI/2 }, { e: 0.99, M: 3*Math.PI/2 }
    ];
    for (const tc of testCases) {
      let E = tc.e < 0.8 ? tc.M : Math.PI;
      let iterations = 0;
      for (let i = 0; i < 12; i++) {
        const f = E - tc.e * Math.sin(E) - tc.M;
        const fp = 1 - tc.e * Math.cos(E);
        const d = f / fp;
        E -= d;
        iterations++;
        if (Math.abs(d) < 1e-11) break;
      }
      const residual = E - tc.e * Math.sin(E) - tc.M;
      if (Math.abs(residual) > 1e-9) {
        logViolation('KeplerSolverConvergence', 'WARNING', `Kepler solver residual too large for e=${tc.e}, M=${tc.M}`, 'residual < 1e-9', residual.toExponential(3));
      }
      if (tc.e < 0.8 && iterations > 12) {
        logViolation('KeplerSolverConvergence', 'WARNING', `Kepler solver took too many iterations for e=${tc.e}`, 'iterations <= 12', iterations);
      }
    }
  }

  function checkRK4Order(flight, bodies) {
    logViolation('RK4OrderVerification', 'INFO', 'RK4 order check not yet implemented', 'placeholder', 'placeholder');
  }

  function checkCollisionBoundary(flight, bodies) {
    logViolation('CollisionDetectionBoundary', 'INFO', 'Collision boundary check not yet implemented', 'placeholder', 'placeholder');
  }

  function checkWarpStability(flight, bodies) {
    if (warpStabilityDone) return;
    logViolation('WarpStability', 'INFO', 'Warp stability check not yet implemented', 'placeholder', 'placeholder');
  }

  function checkNavigationPrediction(flight, bodies) {
    if (!window.ExolineNav || !window.ExolineNav.predictTrajectory) return;
    const pred = window.ExolineNav.predictTrajectory({});
    if (!pred || !pred.records || pred.records.length === 0) return;
    const first = pred.records[0];
    const dx = first.r.x - flight.s.r.x;
    const dy = first.r.y - flight.s.r.y;
    const dist = Math.hypot(dx, dy);
    if (dist > 1) {
      logViolation('NavigationPredictionConsistency', 'WARNING', 'Predicted trajectory first point does not match craft position', 'distance < 1m', dist.toFixed(3));
    }
    for (const rec of pred.records) {
      if (!Number.isFinite(rec.r.x) || !Number.isFinite(rec.r.y)) {
        logViolation('NavigationPredictionConsistency', 'CRITICAL', 'Predicted trajectory contains non-finite values', 'all finite', 'NaN/Infinity found');
        break;
      }
    }
  }

  function checkBodyEphemeris(bodies) {
    for (const [id, body] of Object.entries(bodies)) {
      if (!Number.isFinite(body.x) || !Number.isFinite(body.y)) {
        logViolation('BodyEphemerisSanity', 'CRITICAL', `Body ${id} has non-finite position`, 'finite', `${body.x}, ${body.y}`);
      }
    }
  }

  function logViolation(check, severity, message, expected, actual) {
    violations.push({ timestamp: Date.now(), check, severity, message, expected, actual });
    if (violations.length > MAX_VIOLATIONS) violations.shift();
    if (severity === 'CRITICAL') console.warn('[PHYSICS]', check, message);
  }

  function drawDebugOverlay(ctx) {
    const urlParams = new URLSearchParams(window.location.search);
    if (!urlParams.has('physics-debug')) return;
    const summary = getSummary();
    const recent = violations[violations.length - 1];
    ctx.save();
    ctx.fillStyle = 'rgba(0, 0, 0, 0.8)';
    ctx.fillRect(window.innerWidth - 320, 10, 310, 100);
    ctx.fillStyle = '#e8f8ff';
    ctx.font = '12px monospace';
    ctx.fillText(`Frame: ${summary.lastCheckFrame || 'N/A'}`, window.innerWidth - 310, 30);
    ctx.fillText(`Violations: ${summary.total}`, window.innerWidth - 310, 50);
    ctx.fillText(`Critical: ${summary.critical}`, window.innerWidth - 310, 70);
    if (recent) {
      ctx.fillText(recent.message.substring(0, 80), window.innerWidth - 310, 90);
    }
    ctx.restore();
  }

  return {
    check,
    getViolations: () => [...violations],
    getSummary: () => ({
      total: violations.length,
      critical: violations.filter(v => v.severity === 'CRITICAL').length,
      lastCheckFrame: lastCheckFrame
    }),
    isEnabled: () => enabled,
    drawDebugOverlay,
    VERSION: '0.0.5'
  };
})();