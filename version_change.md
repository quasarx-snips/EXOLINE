### v0.0.5 — Physics stability, frozen node planning, and assisted-burn overhaul

- Added a read-only physics validation agent (`app/physics-agent.js`, 20 checks across light/deep tiers: state finiteness, mass/throttle sanity, vis-viva, energy and momentum conservation, SOI/rocket-equation/fuel-flow/TWR/atmosphere/drag checks, Kepler/RK4/collision/warp/prediction/ephemeris checks) with a `?physics-debug` overlay. It never mutates game state.
- Added an offline physics validator (`tools/validate_physics.py`, 12 checks: gravitational parameters, SOI sanity, orbital elements, moon orbits, mass/radius ratios, rocket equation, escape velocity, Hohmann Δv, timestep stability, atmosphere data, Δv budget). All checks pass, exit 0.
- Added flight-engine safety guards: NaN state detection sets crashed instead of throwing, propellant floor at zero, and a mass floor for thrust/mass division. Added navigation-engine null-body and division-by-zero guards.
- Fixed launch thrust pointing into the planet: parking-orbit heading is now prograde, and throttle-up snaps to the current prograde. Added a Settings PROGRADE LOCK assist (on by default, re-snaps every RK4 substep, turn keys and auto-burn override it).
- Reworked maneuver nodes into frozen target paths: each node carries an absolute burn epoch plus a burn state and inertial Δv vector solved once at edit time. The plan re-solves only on edits, target changes, or after a manual burn — never per frame — so the white line sits perfectly still at every warp.
- Made the planet frame primary: closed node orbits render as a frozen ellipse around the live body position, impact plans draw a red planet-relative path with an IMPACT marker, and escape plans draw an orange planet-relative path with an ESCAPE label. The sun-frame inertial polyline moved behind a Settings HELIO PATH toggle (default off). Node markers sit on the blue orbit via planet-relative burn offsets.
- Reworked auto-burn execution: burns start half a burn-length early (KSP-style centering), steer the frozen burn vector with a proportional-rate pitch controller, modulate throttle to land within ~0.1 m/s of planned Δv, track delivered Δv by integrated thrust acceleration (exact with infinite fuel too), force 1× warp while aligning/burning, and carry a sim-time watchdog so no burn can run forever.
- Split perturbed high-warp flight into ≤120 s chunks with a fresh ephemeris each chunk, closing the stale-body-position energy leak (error grows with t²). Pure circular-hold coast keeps its exact single-step path.
- Replaced the straight escape ray with the analytic hyperbola branch in the planet frame, drawn from the craft to the SOI boundary with PE and SOI EXIT markers (hyperbolic impactors now draw the impact arc instead).
- Fixed target clearing leaving a stale approach line (target changes now re-solve the plan), the stuck TARGETED ✓ button label, and the hardcoded node-creation toast (now shows the real T+ time).

### v0.0.4 — Navigation, maneuver planning, and assisted burns

- Added a dedicated navigation engine that consumes the existing flight state, physics constants, and orbital ephemeris; target selection, relative telemetry, closest-approach estimates, SOI classification, maneuver planning, and transfer estimates now share the same physical coordinate system as flight.
- Added target COM brackets, current SOI/target/relative-velocity/orbital diagnostics, safe hyperbolic-orbit reporting, and focus/reset navigation controls.
- Added maneuver nodes with editable prograde, radial, and normal components, total Δv, plan-only propagation, selectable red node markers, keyboard controls, and orbit-click `ADD NODE` placement.
- Added local orbital visualization: the live blue conic, a white dotted planet-relative predicted node orbit, and a yellow dotted propagated transfer preview. Impacting trajectories now stop at a predicted surface intersection instead of drawing a false closed orbit.
- Added assisted auto-burn sequencing: it coasts under controlled warp, returns to 1× to align, takes temporary throttle control, checks the rocket-equation propellant requirement before arming, burns with live thrust/mass/Isp, and consumes the node once complete.
- Added a Settings-panel Infinite Fuel cheat. It prevents propellant depletion while deliberately preserving the craft mass, as documented in the UI.
- Added body-specific exponential atmospheric drag to live flight and preview propagation: Earth (100 km), Venus (250 km), Mars (125 km), and Titan (600 km), using approximate real-world density and scale-height ratios.
- Added startup and navigation-preview guards so a preview exception cannot leave the player trapped behind the intro screen.
- Fixed warp/physics epoch desynchronization: de-orbit and perturbed trajectories no longer advance celestial time farther than the craft integration. Exact circular coasting still supports full warp; perturbed trajectories are stepped in bounded RK4 chunks with queued simulation time.
- Added editable, persistent Settings keybinds for pause, warp, craft focus, reset, node creation, and auto-burn.
- Fixed dense-atmosphere integration instability by making RK4 timesteps drag-aware in both flight and prediction. SOI classification now uses the actual nominal SOI boundary rather than instantaneous gravity dominance, while all-body Newtonian gravity remains continuous.

Navigation foundation and validation:
- navigation-engine.js: restored the missing `soiRadius` closing brace/return/buildGrid header; added public exports (`buildGrid`, `gridAt`, `gravityAcc`, `propagateLeg`, `closestApproachIn`, `buildPreview`, `buildSnapshot`) plus `dv_vec` on nodes.
- validation/navigation-validator.js: harness C8–C13, C15/C19, Scenarios A/B/C and `makeContext`/`getBodies`/`nav.init` shims aligned to the engine data model; export contract scan reports `used but not exported: NONE`, exit 0.
- tools/check_contract.py: comma-separated export parsing; exits 0 when nothing is used but not exported.
- tools/static_check.py: fixed `tree.root_node.text` line counting (bytes in this tree-sitter build); `ALL FILES PARSED OK`, exit 0.
- tools/validate_all.py: engine brace depth 0; `solar_system.json`, `physics_constants.json`, `render_anchors.json` all valid JSON, exit 0.
- tools/depth_scan.py: harness final depth 0, exit 0.
- app/app.js: the spacecraft trajectory is now local to the body whose sphere of influence the craft has entered — a closed conic drawn around the SOI body (the old wavy solar-frame line is gone), escape path and periapsis/apoapsis markers drawn in the body's local frame, and the camera centres on the SOI body while inside it. The navigation plan polyline and craft render in the same body frame.
- app/app.js: planet/moon mineral profile now populated — `data/mineral_profiles.json` is loaded and rendered into the detail panel's MINERAL PROFILE section (name, percentage, bar) for every catalogued body. Previously the panel existed in the HTML/CSS but no code ever wrote into it.

### v0.0.3 — Orbital flight update

- Softened the lower edges of the top flight-deck trays while keeping their upper edges aligned to the device edge.
- Made RESET an icon-only rounded control.
- Added 10M×, 100M×, and 1B× warp levels; high warp now advances ephemeris time at the selected rate instead of collapsing to the old backlog cap.
- Added a selectable triangular spacecraft with camera focus, throttle, and corrected rotation controls.
- Added three-dimensional Newtonian point-mass gravity from every catalogued body, RK4 integration, moving-body force evaluation, propellant mass flow, and collision cutoff.
- Added live orbital diagnostics plus labelled periapsis and apoapsis altitude markers for closed orbits.
- Added a dashed, forward escape guide and periapsis marker for hyperbolic escape trajectories.
- Synchronized moon orbit paths with their propagated anomaly, removing path/body displacement.
- Reworked atmospheric bands to meet the surface cleanly, with lighter colour and an explicit day/night terminator.
- Made atmospheric edge overlap opaque at the surface and fade only at its outer edge, hiding sprite-edge pixel breakup.
- Added real sidereal rotation ratios for every major planet and dwarf planet; the fixed solar terminator now shows clear day/night progression as textures rotate.
- Changed time warp to advance in synchronized ephemeris slices, preserving an idle spacecraft's orbit across warp changes.
- Added an exact circular coasting reference for the initial parking orbit, keeping PE/AP fixed until the first engine burn releases it into the full perturbation model.
- Anchored every rendered orbital path at the body's current anomaly and calibrated sprite alpha centers, eliminating visible planet/path offsets at deep zoom.
- Expanded body picking to the full rendered planetary disk.
- Rebuilt time controls with larger icon buttons, reliable pointer hit areas, and keyboard shortcuts (`[` / `]` / Space).
- Made every body's atmospheric halo follow the solar terminator, so the atmosphere falls dark across the night side in step with the rotating day/night cycle.
- Made every body's atmospheric halo follow the solar terminator, so the atmosphere falls dark across the night side in step with the rotating day/night cycle.
- Reworked the whole interface around the light-blue flight-deck theme and made it far more compact: every button, tray, and readout is now a small pill with navy-on-light-blue styling, the top rows no longer overlap (view/flight actions + warp controls above; mission clock + vehicle status on one strip below), and mission-menu options, panels, and the map bar follow the same theme.
- Moved the vehicle-status strip to the centre of the top row, between the action cluster and the warp tray, and gave the top chrome — action cluster, status strip, warp tray, and map title — SFS-style trapezium borders with only two parallel sides; below 1180px the strip drops back to its own centred row.
- Slimmed the top-left cluster to just a ☰ settings button (wired up later) and a 👁 VIEW button, parked the RESET pill in the bottom-left corner (it moves under the cluster below 740px so the HUD stays clear), and smoothed the trapezium borders: gentler 10px slant, a parallel inner outline so the white edge stays even along the slants, softer ring and shadow.
- Flushed all top chrome (settings/view cluster, status strip, warp tray) flush against the device edge, and rotated the RESET tab 90° anticlockwise so its straight side runs along the left edge with its rounded corners facing inward.
- Chrome tab borders (status strip, warp tray, map title, action cluster) and the RESET tab outline switched to solid black.

### v0.0.2 — Solar System generation

- Added the JPL-style Solar System explorer, orbital body assets, moons, maps, and terrain data.

### v0.0.1 — Dataset generation

- Established the canonical Solar System, terrain, and resource datasets.
# Repository cleanup and contributor documentation

- Fixed non-circular high-warp progression: escaping and de-orbiting craft now consume a bounded high-warp physics interval instead of being capped at five simulated seconds per frame.
- Tightened coast integration steps to reduce PE/AP drift after a burn.
- Replaced the simplified impact/escape display with drag-aware numerical prediction when the craft is in an atmosphere, on an impact path, or escaping an SOI. The displayed curve is now clickable to place a maneuver node.
- Increased orbit/path click tolerance so the contextual `+ ADD NODE` button is reliably available above nearby bodies.
- Added `docs/DEVELOPER_GUIDE.md`: task-to-file routing, runtime data flow, physics/navigation boundaries, and focused validation steps for new contributors.
- Linked the README to the new guide.
- Removed one-off, hard-coded local validation helpers; obsolete generated validation reports; the empty navigation validator; the stale checksum manifest; and ignored recovery/cache artifacts from the working tree.
