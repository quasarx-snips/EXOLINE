## EXOLINE changelog

### v0.0.4 — Flight-deck polish and extended time warp

- Softened the lower edges of the top flight-deck trays while keeping their upper edges aligned to the device edge.
- Made RESET an icon-only rounded control.
- Added 10M×, 100M×, and 1B× warp levels; high warp now advances ephemeris time at the selected rate instead of collapsing to the old backlog cap.

### v0.0.3 — Orbital flight update

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
