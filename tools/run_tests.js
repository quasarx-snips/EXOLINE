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
  const p = path.join(__dirname, '..', file);
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

  const S = {
    earth: { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 },
    moon: { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 },
    jupiter: { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 },
    mars: { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 },
    sun: { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 },
  };

  // A3 CIRCULAR HOLD
  console.log('A3 CIRCULAR HOLD...');
  const F3 = new ExolineFlight.Flight(P);
  F3.launch('earth', S);
  F3.s.throttle = 0;
  F3.step(3600, S);
  const mu = G * P.bodies.earth.mass;
  const r = Math.sqrt(F3.s.r.x*F3.s.r.x + F3.s.r.y*F3.s.r.y);
  const expectedR = P.bodies.earth.radius_m + 180000;
  const expectedV = Math.sqrt(mu / expectedR);
  const alt = r - P.bodies.earth.radius_m;
  assert(Math.abs(alt - 180000) < 500, `altitude ${alt} not within 500m of 180km`);
  assert(Math.abs(F3.s.v.length() - expectedV) < 1, `speed ${F3.s.v.length().toFixed(3)} vs ${expectedV.toFixed(3)}`);
  const E = 0.5 * (F3.s.v.x*F3.s.v.x + F3.s.v.y*F3.s.v.y) - mu / r;
  const E0 = 0.5 * expectedV * expectedV - mu / expectedR;
  assert(Math.abs((E - E0) / E0) < 1e-6, `energy drift ${((E-E0)/E0).toExponential(3)}`);
  console.log(`  PASS: alt=${alt/1000}km, speed=${F3.s.v.length().toFixed(2)}m/s\n`);

  // A4 PROGRADE BURN
  console.log('A4 PROGRADE BURN...');
  const F4 = new ExolineFlight.Flight(P);
  F4.launch('earth', S);
  const beforeApo = F4.diagnostics(S, 'earth').apo;
  F4.s.throttle = 1;
  F4.s.heading = 0;
  F4.step(60, S);
  F4.s.throttle = 0;
  const afterApo = F4.diagnostics(S, 'earth').apo;
  assert(afterApo - beforeApo > 10000, `apo change ${(afterApo-beforeApo)/1000}km <= 10km`);
  console.log(`  PASS: apo change = ${(afterApo - beforeApo)/1000}km\n`);

  // A5 FUEL FLOOR
  console.log('A5 FUEL FLOOR...');
  const F5 = new ExolineFlight.Flight(P);
  F5.s.propellant = 1;
  F5.s.throttle = 1;
  F5.step(10, S);
  assert(F5.s.propellant === 0, `propellant ${F5.s.propellant} !== 0`);
  assert(F5.s.throttle === 0, `throttle ${F5.s.throttle} !== 0`);
  assert(F5.s.m === P.craft.dryMass, `mass ${F5.s.m} !== ${P.craft.dryMass}`);
  assert(Number.isFinite(F5.s.r.x) && Number.isFinite(F5.s.v.x), 'state not finite');
  console.log('  PASS: fuel floor enforced\n');

  // A6 NaN GUARD
  console.log('A6 NaN GUARD...');
  const F6 = new ExolineFlight.Flight(P);
  F6.s.r.x = NaN; F6.s.r.y = 0; F6.s.r.z = 0;
  F6.s.v.x = 0; F6.s.v.y = 0; F6.s.v.z = 0;
  F6.s.throttle = 0;
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

  // A8 CRASH BOUNDARY
  console.log('A8 CRASH BOUNDARY...');
  const F8 = new ExolineFlight.Flight(P);
  const Rm = P.bodies.moon.radius_m;
  F8.s.r.x = 0; F8.s.r.y = 0; F8.s.r.z = Rm - 1;
  F8.s.v.x = 0; F8.s.v.y = 0; F8.s.v.z = 0;
  F8.s.throttle = 0;
  F8.step(1, S);
  assert(F8.s.crashed === true, 'should crash at R-1m');
  const F8b = new ExolineFlight.Flight(P);
  F8b.s.r.x = 0; F8b.s.r.y = 0; F8b.s.r.z = Rm + 1000;
  F8b.s.v.x = 0; F8b.s.v.y = 0; F8b.s.v.z = 0;
  F8b.s.throttle = 0;
  F8b.step(60, S);
  assert(F8b.s.crashed === false, 'should not crash at R+1000m');
  console.log('  PASS: crash boundary correct\n');

  // A9 EARTH DRAG
  console.log('A9 EARTH DRAG...');
  const F9 = new ExolineFlight.Flight(P);
  F9.launch('earth', S);
  const r9 = P.bodies.earth.radius_m + 50000;
  F9.s.r.x = r9; F9.s.r.y = 0; F9.s.r.z = 0;
  F9.s.v.x = 0; F9.s.v.y = 7600; F9.s.v.z = 0;
  F9.s.throttle = 0;
  const vBefore = Math.sqrt(F9.s.v.x*F9.s.v.x + F9.s.v.y*F9.s.v.y);
  F9.step(600, S);
  const vAfter = Math.sqrt(F9.s.v.x*F9.s.v.x + F9.s.v.y*F9.s.v.y);
  assert(vAfter < vBefore, `speed not decreasing: ${vBefore} -> ${vAfter}`);
  console.log(`  PASS: speed 
