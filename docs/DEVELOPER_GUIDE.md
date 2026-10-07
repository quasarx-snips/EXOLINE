# EXOLINE developer guide

This is the fast entry point for a new contributor. Start with the task you were given, find its row below, then work only in the listed owner files unless the change genuinely crosses a boundary.

## Run and check

Serve the repository root with a local HTTP server, then open `/app/`. Do not open `app/index.html` directly: the app fetches data files and browsers block those requests from `file://` pages.

```bash
python -m http.server 8000
```

For a focused numerical smoke check, run `python tools/validate_flight.py`. `tools/validate_runtime.py` checks that catalog entries, terrain manifests, and image files agree; it requires Pillow.

Before handing off a change, load the app with the browser console open, verify the loading screen clears, and exercise the changed control at 1x and a time-warp setting. Keep the console free of errors.

## Project map

| Area | Owner | Change here when… |
| --- | --- | --- |
| Bootstrap and UI DOM | `app/index.html` | Adding/removing a HUD control, panel, button, or script. Keep script order: orbit, flight, map, navigation, app. |
| Visual theme | `app/style.css` | Changing layout, typography, colors, responsive behavior, HUD visibility, or pointer layering. |
| App/controller | `app/app.js` | Wiring input, selection, camera behavior, canvas drawing, HUD updates, settings, and the main frame loop. |
| Craft physics | `app/flight-engine.js` | Changing forces, integration, throttle, fuel use, atmospheric drag, collisions, or SOI decisions. |
| Maneuvers | `app/navigation-engine.js` | Changing node placement, delta-v handles, predicted trajectories, burn timing, or auto-burn behavior. |
| Celestial positions | `app/orbit-engine.js` | Changing how planet/moon positions are calculated from orbital elements. |
| Surface-map renderer | `app/map-renderer.js` | Changing tiled-map loading, map pan/zoom, or map drawing. |
| Game data | `data/*.json` | Changing body catalog entries, masses/radii, orbital elements, atmosphere parameters, or tile manifests. |
| Visual assets | `assets/` | Replacing source imagery. Keep paths aligned with `data/solar_system.json` and `data/terrain_manifest.json`. |

## Runtime flow

```text
index.html
  └─ loads engines in dependency order
       ├─ orbit-engine: planet/moon state from orbital data
       ├─ flight-engine: spacecraft state from forces and controls
       ├─ map-renderer: surface tiles
       └─ navigation-engine: nodes + prediction + auto-burn
  └─ app.js start()
       ├─ fetches catalog and constants from data/
       ├─ creates the flight and navigation engines
       └─ frame()
            ├─ advances time and craft state
            ├─ updates maneuver/auto-burn state
            ├─ draws the system and predicted paths
            └─ refreshes HUD and panels
```

## Task routing

### Camera, selection, or missing controls

Check `controls()`, pointer handlers, canvas hit-testing, and `draw()` in `app/app.js`. A new interactive canvas item must be drawn above body hit targets if it needs to remain clickable. Confirm pointer events do not get intercepted by a panel.

### Orbital or atmosphere behavior

Begin in `app/flight-engine.js`; do not patch physics by moving pixels in the renderer. Check units first: position is meters, velocity is meters/second, mass is kilograms, and engine time is seconds. Atmospheric parameters belong in `data/physics_constants.json`. Verify both a stable orbit and an atmospheric descent after a change.

### Maneuver nodes and automatic burns

Use `app/navigation-engine.js` for the node lifecycle and prediction. A node stores a fixed simulation time, not a screen position or a craft-relative time. Prediction should use the active SOI body. Auto-burn must use normal throttle/fuel paths in `flight-engine.js`; it must never directly change craft velocity or fuel.

### Key bindings and settings

The defaults, persistence, and event routing are in `app/app.js`; visible controls are in `app/index.html` and styles in `app/style.css`. Preserve editable-control guards so typing into a settings field does not activate a flight command.

### Assets and data

Asset paths are declared in `data/solar_system.json`; terrain tiles are declared by `data/terrain_manifest.json`. Do not add temporary archives or rebuild caches under `assets/`. The app only uses files referenced by these manifests.

## Boundaries that prevent common regressions

- Do not access DOM elements inside engine modules. Engines should stay usable from tests and return plain state.
- Do not make `app.js` reach into a navigation engine's private variables. Add a small public method instead.
- Do not mutate a maneuver node as time advances. Its event time must remain fixed until the user edits or deletes it.
- Do not apply auto-burn delta-v as a teleport. Route it through craft orientation, throttle, available thrust, and fuel.
- Do not use planet-screen coordinates as physics coordinates. Rendering uses a transformed display space.
- Do not replace `assets/orbital/` from an archive without verifying the data-manifest paths and browser load.

## Files that are intentionally not runtime

`docs/` holds project/reference documentation. `references/` holds visual reference images. `tools/validate_flight.py` and `tools/validate_runtime.py` are developer checks. Generated reports, contact sheets, ZIP exports, and reconstructed-asset caches are deliberately ignored.
