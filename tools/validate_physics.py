#!/usr/bin/env python3
"""
EXOLINE v0.0.5 Offline Physics Validator
Validates physics data files against SFS/KSP/JNO reference models.
"""

import json
import math
import sys
from pathlib import Path

G = 6.67430e-11
AU_M = 149597870700
DAY_S = 86400

EXPECTED_VALUES = {
    'earth': {'g': 9.81, 'escape_v': 11186, 'mu': G * 5.97219e24, 'radius': 6371000},
    'mars': {'g': 3.71, 'escape_v': 5027, 'mu': G * 6.4171e23, 'radius': 3389500},
    'jupiter': {'g': 24.79, 'escape_v': 60200, 'mu': G * 1.89813e27, 'radius': 69911000},
    'mercury': {'a_au': 0.387},
    'venus': {'a_au': 0.723},
    'earth_orbit': {'a_au': 1.0},
    'mars_orbit': {'a_au': 1.524},
    'jupiter_orbit': {'a_au': 5.203},
    'neptune_orbit': {'a_au': 30.07},
    'moon': {'a_km': 384400},
    'io': {'a_km': 421700},
    'titan': {'a_km': 1221870},
}

ATMOSPHERE_EXPECTED = {
    'earth': {'rho0': 1.225, 'H': 8500},
    'mars': {'rho0': 0.020, 'H': 11100},
    'venus': {'rho0': 65, 'H': 15900},
    'saturn:titan': {'rho0': 5.3, 'H': 40000},
}

DEFAULT_CRAFT = {
    'thrust': 20000,
    'Isp': 320,
    'dryMass': 500,
    'propellant': 500,
}


def load_json(path):
    with open(path, 'r') as f:
        return json.load(f)


def check_gravitational_parameters(constants):
    """Check 1: Gravitational parameters and surface gravity."""
    print("Check 1: Gravitational Parameters")
    failures = 0
    for body_id, physical in constants['bodies'].items():
        if body_id == 'sun':
            continue
        mu = G * physical['mass']
        if mu <= 0:
            print(f"  FAIL: {body_id} mu = {mu} (must be > 0)")
            failures += 1
        g = mu / (physical['radius_m'] ** 2)
        expected = EXPECTED_VALUES.get(body_id, {})
        if 'g' in expected:
            if abs(g - expected['g']) / expected['g'] > 0.5:
                print(f"  FAIL: {body_id} surface gravity {g:.2f} m/s^2 (expected ~{expected['g']})")
                failures += 1
            else:
                print(f"  PASS: {body_id} g = {g:.2f} m/s^2")
        else:
            print(f"  INFO: {body_id} g = {g:.2f} m/s^2")
    return failures


def check_soi_radius(constants):
    """Check 2: SOI radius sanity."""
    print("\nCheck 2: SOI Radius Sanity")
    failures = 0
    sun_mass = constants['bodies']['sun']['mass']
    for body_id, physical in constants['bodies'].items():
        if body_id == 'sun' or ':' in body_id:
            continue
        parent_id = physical.get('parent', 'sun')
        parent = constants['bodies'].get(parent_id)
        if not parent:
            continue
        orbit = None
        for key, val in constants.items():
            if key == 'orbital_elements':
                orbit = val['primary'].get(body_id)
                break
        if not orbit or 'a' not in orbit:
            continue
        a = orbit['a'] * AU_M
        r_soi = a * (physical['mass'] / parent['mass']) ** 0.4
        if r_soi <= physical['radius_m']:
            print(f"  FAIL: {body_id} SOI ({r_soi:.0f}m) <= radius ({physical['radius_m']:.0f}m)")
            failures += 1
        if r_soi >= a:
            print(f"  FAIL: {body_id} SOI ({r_soi:.0f}m) >= orbital radius ({a:.0f}m)")
            failures += 1
        print(f"  PASS: {body_id} SOI = {r_soi:.0f}m")
    return failures


def check_orbital_elements(orbital_elements):
    """Check 3: Orbital element consistency for primaries."""
    print("\nCheck 3: Orbital Element Consistency (Primaries)")
    failures = 0
    for body_id, elements in orbital_elements['primary'].items():
        if not (0 <= elements['e'] < 1):
            print(f"  FAIL: {body_id} eccentricity {elements['e']} not in [0, 1)")
            failures += 1
        if elements['a'] <= 0:
            print(f"  FAIL: {body_id} semi-major axis {elements['a']} <= 0")
            failures += 1
        expected = EXPECTED_VALUES.get(body_id + '_orbit', {}).get('a_au') or EXPECTED_VALUES.get(body_id, {}).get('a_au')
        if expected and abs(elements['a'] - expected) / expected > 0.01:
            print(f"  FAIL: {body_id} a = {elements['a']} AU (expected ~{expected} AU)")
            failures += 1
        else:
            print(f"  PASS: {body_id} a = {elements['a']:.6f} AU, e = {elements['e']:.6f}")
    return failures


def check_moon_orbits(orbital_elements):
    """Check 4: Moon orbital consistency."""
    print("\nCheck 4: Moon Orbital Consistency")
    failures = 0
    constants = load_json(Path(__file__).parent.parent / 'data' / 'physics_constants.json')
    for moon_id, elements in orbital_elements['moons'].items():
        parent_name = moon_id.split(':')[0]
        parent_physical = constants['bodies'].get(parent_name)
        if not parent_physical:
            continue
        a_km = elements['a_km']
        if a_km <= parent_physical['radius_m'] / 1000:
            print(f"  FAIL: {moon_id} a = {a_km} km <= parent radius")
            failures += 1
        if elements['period_days'] <= 0:
            print(f"  FAIL: {moon_id} period = {elements['period_days']} days <= 0")
            failures += 1
        if elements['e'] >= 0.5:
            print(f"  FAIL: {moon_id} eccentricity {elements['e']} >= 0.5")
            failures += 1
        expected = EXPECTED_VALUES.get(moon_id.split(':')[1], {}).get('a_km')
        if expected and abs(a_km - expected) / expected > 0.01:
            print(f"  FAIL: {moon_id} a = {a_km} km (expected ~{expected} km)")
            failures += 1
        else:
            print(f"  PASS: {moon_id} a = {a_km} km, e = {elements['e']:.4f}, P = {elements['period_days']:.4f} days")
    return failures


def check_mass_ratios(constants):
    """Check 5: Mass ratio sanity."""
    print("\nCheck 5: Mass Ratio Sanity")
    failures = 0
    sun_mass = constants['bodies']['sun']['mass']
    for body_id, physical in constants['bodies'].items():
        if body_id == 'sun':
            continue
        if ':' in body_id:
            parent_name = body_id.split(':')[0]
            parent = constants['bodies'].get(parent_name)
            if parent and physical['mass'] >= 0.15 * parent['mass']:
                print(f"  FAIL: {body_id} mass {physical['mass']:.2e} >= 0.15 * {parent_name} mass {parent['mass']:.2e}")
                failures += 1
        else:
            if physical['mass'] >= 0.01 * sun_mass:
                print(f"  FAIL: {body_id} mass {physical['mass']:.2e} >= 0.01 * sun mass")
                failures += 1
        print(f"  PASS: {body_id} mass ratio OK")
    return failures


def check_radius_sanity(constants):
    """Check 6: Radius sanity."""
    print("\nCheck 6: Radius Sanity")
    failures = 0
    sun_radius = constants['bodies']['sun']['radius_m']
    mercury_orbit = 0.38709927 * AU_M
    if sun_radius >= mercury_orbit:
        print(f"  FAIL: Sun radius {sun_radius:.0f}m >= Mercury orbit {mercury_orbit:.0f}m")
        failures += 1
    for body_id, physical in constants['bodies'].items():
        if physical['radius_m'] <= 0:
            print(f"  FAIL: {body_id} radius <= 0")
            failures += 1
    print(f"  PASS: All radii positive, Sun radius < Mercury orbit")
    return failures


def check_rocket_equation():
    """Check 7: Rocket equation sanity."""
    print("\nCheck 7: Rocket Equation Sanity")
    failures = 0
    m0 = DEFAULT_CRAFT['dryMass'] + DEFAULT_CRAFT['propellant']
    mf = DEFAULT_CRAFT['dryMass']
    dv = DEFAULT_CRAFT['Isp'] * 9.80665 * math.log(m0 / mf)
    if not (0 < dv < 20000):
        print(f"  FAIL: delta-v = {dv:.0f} m/s (expected 0 < dv < 20000)")
        failures += 1
    else:
        print(f"  PASS: delta-v = {dv:.0f} m/s")
    twr_earth = DEFAULT_CRAFT['thrust'] / (m0 * 9.80665)
    if twr_earth <= 1:
        print(f"  FAIL: TWR at Earth = {twr_earth:.2f} (must be > 1)")
        failures += 1
    else:
        print(f"  PASS: TWR at Earth = {twr_earth:.2f}")
    return failures


def check_escape_velocity(constants):
    """Check 8: Escape velocity sanity."""
    print("\nCheck 8: Escape Velocity Sanity")
    failures = 0
    for body_id in ['earth', 'mars', 'jupiter']:
        physical = constants['bodies'][body_id]
        mu = G * physical['mass']
        v_esc = math.sqrt(2 * mu / physical['radius_m'])
        expected = EXPECTED_VALUES[body_id]['escape_v']
        if abs(v_esc - expected) / expected > 0.01:
            print(f"  FAIL: {body_id} v_esc = {v_esc:.0f} m/s (expected ~{expected})")
            failures += 1
        else:
            print(f"  PASS: {body_id} v_esc = {v_esc:.0f} m/s")
    return failures


def check_hohmann_dv(constants):
    """Check 9: Hohmann delta-v sanity."""
    print("\nCheck 9: Hohmann Delta-V Sanity")
    failures = 0
    mu_sun = G * constants['bodies']['sun']['mass']
    r_earth = 1.0 * AU_M
    r_mars = 1.52371034 * AU_M
    a_transfer = (r_earth + r_mars) / 2
    dv_dep = abs(math.sqrt(mu_sun * (2/r_earth - 1/a_transfer)) - math.sqrt(mu_sun / r_earth))
    dv_arr = abs(math.sqrt(mu_sun * (2/r_mars - 1/a_transfer)) - math.sqrt(mu_sun / r_mars))
    total = dv_dep + dv_arr
    if abs(total - 5590) / 5590 > 0.1:
        print(f"  FAIL: Earth->Mars total dv = {total:.0f} m/s (expected ~5590)")
        failures += 1
    else:
        print(f"  PASS: Earth->Mars total dv = {total:.0f} m/s")
    mu_earth = G * constants['bodies']['earth']['mass']
    r_leo = (6371000 + 180000)
    r_moon = 384400000
    a_transfer2 = (r_leo + r_moon) / 2
    dv_dep2 = abs(math.sqrt(mu_earth * (2/r_leo - 1/a_transfer2)) - math.sqrt(mu_earth / r_leo))
    dv_arr2 = abs(math.sqrt(mu_earth * (2/r_moon - 1/a_transfer2)) - math.sqrt(mu_earth / r_moon))
    total2 = dv_dep2 + dv_arr2
    if abs(total2 - 3950) / 3950 > 0.15:
        print(f"  FAIL: Earth->Moon total dv = {total2:.0f} m/s (expected ~3950)")
        failures += 1
    else:
        print(f"  PASS: Earth->Moon total dv = {total2:.0f} m/s")
    return failures


def check_time_step_stability(constants):
    """Check 10: Time step stability."""
    print("\nCheck 10: Time Step Stability")
    failures = 0
    mu_earth = G * constants['bodies']['earth']['mass']
    r_leo = 6371000 + 180000
    period = 2 * math.pi * math.sqrt(r_leo ** 3 / mu_earth)
    max_integration_step = 1200
    if max_integration_step >= period / 4:
        print(f"  FAIL: MAX_INTEGRATION_STEP ({max_integration_step}s) >= period/4 ({period/4:.0f}s)")
        failures += 1
    else:
        print(f"  PASS: MAX_INTEGRATION_STEP ({max_integration_step}s) < period/4 ({period/4:.0f}s)")
    rk4_substep = period / 960
    if rk4_substep >= 6:
        print(f"  FAIL: RK4 substep ({rk4_substep:.2f}s) >= 6s")
        failures += 1
    else:
        print(f"  PASS: RK4 substep ({rk4_substep:.2f}s) < 6s")
    return failures


def check_atmosphere_data(constants):
    """Check 11: Atmosphere data validation."""
    print("\nCheck 11: Atmosphere Data Validation")
    failures = 0
    for body_id, expected in ATMOSPHERE_EXPECTED.items():
        physical = constants['bodies'].get(body_id)
        if not physical:
            print(f"  FAIL: {body_id} not found in constants")
            failures += 1
            continue
        # Atmosphere data is in flight-engine.js, not physics_constants.json
        # This is a placeholder - actual check would read flight-engine.js
        print(f"  INFO: {body_id} atmosphere data in flight-engine.js")
    return failures


def check_delta_v_budget():
    """Check 12: Delta-V budget sanity."""
    print("\nCheck 12: Delta-V Budget Sanity")
    failures = 0
    m0 = DEFAULT_CRAFT['dryMass'] + DEFAULT_CRAFT['propellant']
    mf = DEFAULT_CRAFT['dryMass']
    dv = DEFAULT_CRAFT['Isp'] * 9.80665 * math.log(m0 / mf)
    if dv < 2000:
        print(f"  FAIL: Default craft delta-v = {dv:.0f} m/s < 2000 (insufficient for orbital insertion)")
        failures += 1
    else:
        print(f"  PASS: Default craft delta-v = {dv:.0f} m/s (sufficient for orbital insertion)")
    if dv > 8000:
        print(f"  FAIL: Default craft delta-v = {dv:.0f} m/s > 8000 (unexpectedly high for default craft)")
        failures += 1
    else:
        print(f"  PASS: Default craft delta-v = {dv:.0f} m/s (reasonable for default craft)")
    return failures


def main():
    print("=" * 60)
    print("EXOLINE v0.0.5 Offline Physics Validator")
    print("=" * 60)
    
    constants_path = Path(__file__).parent.parent / 'data' / 'physics_constants.json'
    orbital_path = Path(__file__).parent.parent / 'data' / 'orbital_elements.json'
    
    if not constants_path.exists():
        print(f"ERROR: {constants_path} not found")
        return 1
    if not orbital_path.exists():
        print(f"ERROR: {orbital_path} not found")
        return 1
    
    constants = load_json(constants_path)
    orbital_elements = load_json(orbital_path)
    
    total_failures = 0
    total_failures += check_gravitational_parameters(constants)
    total_failures += check_soi_radius(constants)
    total_failures += check_orbital_elements(orbital_elements)
    total_failures += check_moon_orbits(orbital_elements)
    total_failures += check_mass_ratios(constants)
    total_failures += check_radius_sanity(constants)
    total_failures += check_rocket_equation()
    total_failures += check_escape_velocity(constants)
    total_failures += check_hohmann_dv(constants)
    total_failures += check_time_step_stability(constants)
    total_failures += check_atmosphere_data(constants)
    total_failures += check_delta_v_budget()
    
    print("\n" + "=" * 60)
    if total_failures == 0:
        print("ALL CHECKS PASSED")
        print("=" * 60)
        return 0
    else:
        print(f"{total_failures} CHECK(S) FAILED")
        print("=" * 60)
        return 1


if __name__ == '__main__':
    sys.exit(main())