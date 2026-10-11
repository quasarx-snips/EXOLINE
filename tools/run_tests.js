/**
 * EXOLINE v0.1.0 Test Runner — dependency-free Node harness
 * stubs window, fetch, performance; evals engine files; runs TIER A assertions
 */
'use strict';

const fs = require('fs');
const path = require('path');

// ---------- stubs ----------
global.window = {
  ExolineOrbit: null,
  ExolineFlight: null,
  ExolineNav: null,
  ExolinePhysicsAgent: null,
  ExolineMap: null,
  addEventListener: () => {},
  removeEventListener: () => {},
  getComputedStyle: () => ({ getPropertyValue: () => '' }),
  devicePixelRatio: 1,
  innerWidth: 1280,
  innerHeight: 720,
  performance: { now: () => Date.now() },
  requestAnimationFrame: (cb) => setTimeout(cb, 16),
  cancelAnimationFrame: (id) => clearTimeout(id),
  Image: class {},
};

global.document = {
  getElementById: () => null,
  createElement: () => ({
    style: {}, classList: { add: () => {}, remove: () => {}, toggle: () => {} },
    appendChild: () => {}, replaceChildren: () => {}, addEventListener: () => {}
  }),
  querySelectorAll: () => [],
};

global.fetch = (file) => {
  const p = path.resolve(__dirname, '..', 'app', file);
  const content = fs.readFileSync(p, 'utf-8');
  return Promise.resolve({
    ok: true,
    json: () => Promise.resolve(JSON.parse(content)),
    text: () => Promise.resolve(content),
  });
};

global.performance = { now: () => Date.now() };

// ---------- load engine files ----------
function loadEngine(name) {
  const p = path.join(__dirname, '..', 'app', name);
  const src = fs.readFileSync(p, 'utf-8');
  try {
    eval(src);
  } catch (e) {
    throw new Error(`Failed to eval ${name}: ${e.message}`);
  }
}

async function boot() {
  await Promise.all([
    loadEngine('orbit-engine.js'),
    loadEngine('flight-engine.js'),
    loadEngine('navigation-engine.js'),
    loadEngine('physics-agent.js'),
  ]);
  // The engines attach to window.*; the assertions reference them as bare
  // globals (browser semantics), so mirror them onto globalThis here.
  global.ExolineOrbit = window.ExolineOrbit;
  global.ExolineFlight = window.ExolineFlight;
  global.ExolineNav = window.ExolineNav;
  global.ExolinePhysicsAgent = window.ExolinePhysicsAgent;
}

const assert = (cond, msg) => {
  if (!cond) throw new Error(`FAIL: ${msg}`);
};

const AU = 149597870700;
const G = 6.667430e-11;

async function run() {
  console.log('=== EXOLINE v0.1.0 TIER A TESTS ===\n');

  // A1 BOOT
  console.log('A1 BOOT...');
  await boot();
  assert(typeof ExolineOrbit !== 'undefined', 'ExolineOrbit not defined');
  assert(typeof ExolineOrbit.load === 'function', 'ExolineOrbit.load missing');
  await ExolineOrbit.load();
  const now = new Date();
  const pos = await ExolineOrbit.positions(now);
  const primaries = Object.keys(pos).filter(id => id !== 'sun');
  for (const id of primaries) {
    assert(typeof pos[id] === 'object' && pos[id] !== null, `${id} position missing`);
    assert(Number.isFinite(pos[id].x) && Number.isFinite(pos[id].y) && Number.isFinite(pos[id].z || 0), `${id} non-finite`);
  }
  console.log(`  PASS: ${primaries.length} primaries with finite positions\n`);

  // A2 KEPLER ROUND-TRIP
  console.log('A2 KEPLER ROUND-TRIP...');
  const earthState = pos.earth;
  const path = ExolineOrbit.orbitPath('earth', 240, now);
  assert(path.length > 0, 'orbitPath returned empty');
  let minDist = Infinity;
  for (const pt of path) {
    const dx = pt.x - earthState.x, dy = pt.y - earthState.y, dz = (pt.z || 0) - (earthState.z || 0);
    const d = Math.sqrt(dx*dx + dy*dy + dz*dz);
    if (d < minDist) minDist = d;
  }
  assert(minDist < 1e-6 * AU, `minDist ${(minDist/AU).toExponential(3)} AU >= 1e-6 AU`);
  console.log(`  PASS: min dist to state = ${(minDist/AU).toExponential(3)} AU\n`);

  // Mock data for Flight tests
  const P = {
    G,
    bodies: {
      earth: { mass: 5.97219e24, radius_m: 6371000, solidSurface: true },
      moon: { mass: 7.342e22, radius_m: 1737400, solidSurface: true },
      jupiter: { mass: 1.89813e27, radius_m: 69911000, solidSurface: false },
      mars: { mass: 6.4171e23, radius_m: 3389500, solidSurface: true },
      sun: { mass: 1.989e30, radius_m: 696340000, solidSurface: false },
    },
    craft: {
      dryMass: 500,
      propellant: 500,
      thrust: 20000,
      Isp: 320,
      area: 10.0,
      dragCoeff: 0.60,
    },
  };

  // Bodies are SPREAD OUT: stacking them all at the origin (the old fixture)
  // put every craft "inside" every planet at once and summed the Sun's GM
  // onto the pad, which made every flight assertion meaningless. Earth is the
  // origin (the launch site); the rest sit at plausible distances with zero
  // velocity, so the fixture stays static and deterministic.
  const S = {
    earth: { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 },
    moon: { x: 384400000, y: 0, z: 0, vx: 0, vy: 0, vz: 0 },
    jupiter: { x: 778500000000, y: 0, z: 0, vx: 0, vy: 0, vz: 0 },
    mars: { x: -227900000000, y: 0, z: 0, vx: 0, vy: 0, vz: 0 },
    sun: { x: -149597870700, y: 0, z: 0, vx: 0, vy: 0, vz: 0 },
  };

  // A3 LAUNCHPAD: solid bodies are impenetrable and ARE the launchpad, so
  // launch() parks the craft on the surface. It must stay pinned with zero
  // altitude and body-relative velocity while unpowered, hold at TWR <= 1
  // while still burning propellant, and release into flight at TWR > 1.
  console.log('A3 LAUNCHPAD...');
  const F3 = new ExolineFlight.Flight(P);
  F3.launch('earth', S);
  F3.s.throttle = 0;
  F3.step(3600, S);
  const r = Math.sqrt(F3.s.r.x*F3.s.r.x + F3.s.r.y*F3.s.r.y);
  const alt = r - P.bodies.earth.radius_m;
  assert(F3.s.landed === true, 'craft should be landed on the pad');
  assert(alt >= -1 && alt < 1, `pad altitude ${alt} not within 1m of 0`);
  assert(Math.hypot(F3.s.v.x, F3.s.v.y, F3.s.v.z) < 1e-6, 'pad speed must be ~0');
  assert(F3.s.heading > 1.5 && F3.s.heading < 1.6, `pad heading ${F3.s.heading} should be nose-out (PI/2)`);
  // TWR <= 1 held on the pad: stays pinned AND still burns propellant.
  const propBefore = F3.s.propellant;
  F3.s.throttle = 0.3; // stage-1 TWR ~= 0.90 at this mass
  F3.step(30, S);
  assert(F3.s.landed === true, 'TWR<=1 craft must stay pinned on the pad');
  assert(F3.s.propellant < propBefore, `held craft must burn propellant: ${propBefore} -> ${F3.s.propellant}`);
  // Full throttle: TWR > 1 releases the pin and the craft flies off the pad.
  const altBeforeLift = Math.hypot(F3.s.r.x, F3.s.r.y, F3.s.r.z) - P.bodies.earth.radius_m;
  F3.s.throttle = 1;
  F3.step(30, S);
  assert(F3.s.landed === false, 'TWR>1 must release the craft into flight');
  const altAfterLift = Math.hypot(F3.s.r.x, F3.s.r.y, F3.s.r.z) - P.bodies.earth.radius_m;
  assert(altAfterLift > altBeforeLift, `craft must rise off the pad: ${altBeforeLift} -> ${altAfterLift}`);
  F3.s.throttle = 0;
  console.log(`  PASS: pad alt=${alt.toFixed(3)}m, held prop ${propBefore}->${F3.s.propellant.toFixed(1)}kg, liftoff alt=${altAfterLift.toFixed(0)}m\n`);

  // A4 PROGRADE BURN — launch() now starts on the pad, so this test sets up
  // the classic 180 km circular orbit explicitly and measures burn mechanics.
  console.log('A4 PROGRADE BURN...');
  const F4 = new ExolineFlight.Flight(P);
  F4.launch('earth', S);
  const mu4 = G * P.bodies.earth.mass;
  const r4 = P.bodies.earth.radius_m + 180000;
  const v4 = Math.sqrt(mu4 / r4);
  F4.s.landed = false; F4.landedBody = null; F4.landedDir = null;
  F4.s.r = { x: 0, y: r4, z: 0 };
  F4.s.v = { x: -v4, y: 0, z: 0 };
  F4.s.heading = Math.PI;
  const beforeApo = F4.diagnostics(S, 'earth').apo;
  F4.s.throttle = 1;
  F4.step(60, S);
  F4.s.throttle = 0;
  const afterApo = F4.diagnostics(S, 'earth').apo;
  assert(afterApo - beforeApo > 10000, `apo change ${(afterApo-beforeApo)/1000}km <= 10km`);
  console.log(`  PASS: apo change = ${(afterApo - beforeApo)/1000}km\n`);

  // A5 FUEL FLOOR — launch() initializes the stage config, then we wire the
  // tank down to 1 kg so the first RK4 substep exhausts it.
  console.log('A5 FUEL FLOOR...');
  const F5 = new ExolineFlight.Flight(P);
  F5.launch('earth', S);
  F5.s.landed = false; F5.landedBody = null; F5.landedDir = null;
  F5.s.propellant = 1;
  F5.s.throttle = 1;
  F5.step(10, S);
  assert(F5.s.propellant === 0, `propellant ${F5.s.propellant} !== 0`);
  assert(F5.s.throttle === 0, `throttle ${F5.s.throttle} !== 0`);
  assert(F5.s.m === F5.dryMass + F5.payloadMass, `mass ${F5.s.m} !== ${F5.dryMass + F5.payloadMass}`);
  assert(Number.isFinite(F5.s.r.x) && Number.isFinite(F5.s.v.x), 'state not finite');
  console.log('  PASS: fuel floor enforced\n');

  // A6 NaN GUARD — the position must stay finite so maximumStep sizes a real
  // substep; a NaN velocity then trips the rk4 finiteness guard.
  console.log('A6 NaN GUARD...');
  const F6 = new ExolineFlight.Flight(P);
  F6.s.r.x = 0; F6.s.r.y = P.bodies.earth.radius_m + 1000000; F6.s.r.z = 0;
  F6.s.v.x = NaN; F6.s.v.y = 0; F6.s.v.z = 0;
  F6.s.throttle = 1; // powered: skips the analytic-coast capture path
  F6.step(1, S);
  assert(F6.s.crashed === true, `crashed ${F6.s.crashed} !== true after NaN`);
  console.log('  PASS: NaN guard triggers crash\n');

  // A7 SOI DOMINANCE
  console.log('A7 SOI DOMINANCE...');
  const F7 = new ExolineFlight.Flight(P);
  F7.s.r.x = 0; F7.s.r.y = 0; F7.s.r.z = 10000000;
  F7.s.v.x = 0; F7.s.v.y = 0; F7.s.v.z = 0;
  const dom1 = F7.dominant(S);
  const F7b = new ExolineFlight.Flight(P);
  F7b.s.r.x = 0; F7b.s.r.y = 0; F7b.s.r.z = 1000000000;
  F7b.s.v.x = 0; F7b.s.v.y = 0; F7b.s.v.z = 0;
  const dom2 = F7b.dominant(S);
  console.log(`  INFO: close=dominant:${dom1} far=dominant:${dom2}\n`);

  // A8 IMPENETRABLE SURFACE — the mock moon sits at S.moon. An impact above
  // the soft-touchdown threshold crashes, a 1000 m fall reaches impact speed
  // within the step, and in BOTH cases the resolved position must rest ON
  // the crust — never buried inside the body.
  console.log('A8 IMPENETRABLE SURFACE...');
  const F8 = new ExolineFlight.Flight(P);
  const Rm = P.bodies.moon.radius_m;
  F8.s.r.x = S.moon.x; F8.s.r.y = S.moon.y; F8.s.r.z = (S.moon.z || 0) + Rm - 1;
  F8.s.v.x = 0; F8.s.v.y = 0; F8.s.v.z = -100; // 100 m/s straight into the surface
  F8.s.throttle = 0;
  F8.step(1, S);
  assert(F8.s.crashed === true, 'fast impact at R-1m must crash');
  const d8 = Math.hypot(F8.s.r.x - S.moon.x, F8.s.r.y - S.moon.y, F8.s.r.z - (S.moon.z || 0));
  assert(d8 >= Rm - 1e-6, `wreck buried inside moon: d=${d8} < ${Rm}`);
  const F8b = new ExolineFlight.Flight(P);
  F8b.s.r.x = S.moon.x; F8b.s.r.y = S.moon.y; F8b.s.r.z = (S.moon.z || 0) + Rm + 1000;
  F8b.s.v.x = 0; F8b.s.v.y = 0; F8b.s.v.z = 0;
  F8b.s.throttle = 0;
  F8b.step(60, S);
  assert(F8b.s.crashed === true, 'falling onto the surface at speed must crash');
  const d8b = Math.hypot(F8b.s.r.x - S.moon.x, F8b.s.r.y - S.moon.y, F8b.s.r.z - (S.moon.z || 0));
  assert(d8b >= Rm - 1e-6, `wreck buried inside moon: d=${d8b} < ${Rm}`);
  console.log('  PASS: solid surfaces are impenetrable\n');

  // A9 EARTH DRAG
  console.log('A9 EARTH DRAG...');
  const F9 = new ExolineFlight.Flight(P);
  F9.launch('earth', S);
  const r9 = P.bodies.earth.radius_m + 50000;
  F9.s.r.x = r9; F9.s.r.y = 0; F9.s.r.z = 0;
  F9.s.v.x = 0; F9.s.v.y = 7600; F9.s.v.z = 0;
  // launch() now parks on the pad; clear the pin so this airborne drag test runs.
  F9.s.landed = false; F9.landedBody = null; F9.landedDir = null;
  F9.s.throttle = 0;
  const vBefore = Math.sqrt(F9.s.v.x*F9.s.v.x + F9.s.v.y*F9.s.v.y);
  F9.step(600, S);
  const vAfter = Math.sqrt(F9.s.v.x*F9.s.v.x + F9.s.v.y*F9.s.v.y);
  assert(vAfter < vBefore, `speed not decreasing: ${vBefore} -> ${vAfter}`);
  console.log(`  PASS: speed decreased ${vBefore.toFixed(0)} -> ${vAfter.toFixed(0)} m/s\n`);

  // A10 LOI ORBITAL INSERTION — launchOrbit() starts a fresh vehicle in a
  // 400 km circular orbit at exactly circular speed, held on-rails.
  console.log('A10 LOI INSERTION...');
  const F10 = new ExolineFlight.Flight(P);
  F10.launchOrbit('moon', S, 400000);
  const moonPos = S.moon;
  const r10 = Math.hypot(F10.s.r.x - moonPos.x, F10.s.r.y - moonPos.y, F10.s.r.z - (moonPos.z || 0));
  const alt10 = r10 - P.bodies.moon.radius_m;
  assert(F10.s.landed === false, 'LOI start must be airborne, not on the pad');
  assert(F10.circularHold && F10.circularHold.id === 'moon', 'circular hold must be armed');
  assert(Math.abs(alt10 - 400000) < 1, `orbit altitude ${alt10} not 400000 m`);
  const v10 = Math.hypot(F10.s.v.x - (moonPos.vx || 0), F10.s.v.y - (moonPos.vy || 0));
  const vExp10 = Math.sqrt(G * P.bodies.moon.mass / r10);
  assert(Math.abs(v10 - vExp10) < 1, `speed ${v10} != circular ${vExp10}`);
  assert(F10.s.propellant > 0, 'LOI vehicle must launch fuelled');
  F10.step(300, S);
  const r10b = Math.hypot(F10.s.r.x - moonPos.x, F10.s.r.y - moonPos.y, F10.s.r.z - (moonPos.z || 0));
  assert(Math.abs(r10b - r10) < 1000, `on-rails hold drifted ${r10b - r10} m over 300 s`);
  assert(F10.s.landed === false, 'hold must keep the craft airborne');
  console.log(`  PASS: alt=${(alt10 / 1000).toFixed(1)} km, v=${v10.toFixed(1)} m/s\n`);

  console.log('=== ALL TIER A TESTS PASSED ===');
}

run().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); }); 
