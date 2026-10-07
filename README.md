# EXOLINE v0.0.4 — Solar System Explorer (Flight-deck polish / Extended warp build)

This build is the playable Solar-System exploration foundation for EXOLINE v0.0.4.

For a quick, task-oriented map of the codebase, start with [the developer guide](docs/DEVELOPER_GUIDE.md). It identifies the owning file for UI, physics, navigation, data, and asset changes.

## Run

Use a local HTTP server because the app loads JSON and PNG assets via fetch().

```bash
python -m http.server 8000
```

Then open:

`http://localhost:8000/app/`

## Runtime model

- System map: canvas renderer with deterministic JPL-based Keplerian planetary motion.
- Default time scale: 1x real time. Higher warp buttons advance simulation time deliberately.
- Planet selection: click a body; the detail panel appears only after selection.
- Planet map: uses the real PNG surface map from `assets/surface/`.
- Deep map zoom: uses the actual PNG tile sets in `assets/terrain/`, with nearest-neighbour pixel rendering.
- Map panning: pointer/touch drag with inertial glide.
- No runtime procedural terrain generation is used by the viewer.
- Phase 1 surface maps intentionally have no day/night shading; solar illumination is a later feature.

## Controls

- Drag: pan system/map
- Wheel or pinch: zoom
- Click body: inspect
- Double click body: inspect + open surface
- Space: pause/play
- `[` / `]`: decrease/increase time warp
- R: reset view
- Esc: close detail / return

## Important accuracy note

JPL's Keplerian approximation is appropriate for a system-map visualization but is not a substitute for full numerical ephemerides or Horizons in a future precision spacecraft-navigation layer.
