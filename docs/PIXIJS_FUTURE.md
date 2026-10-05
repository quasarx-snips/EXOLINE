# PixiJS future integration

The current explorer uses a dependency-free Canvas 2D proof so the Phase 1 ZIP opens easily. The planned production renderer should preserve the same data contracts while moving to PixiJS.

Future layers:
- TerrainLayer
- EntityLayer
- OrbitLayer
- StructureLayer
- SelectionLayer
- UI/HUD layer

Zoom-dependent structure rendering should follow an OpenFront-like concept: icon at far zoom, richer sprite at intermediate zoom, actual building/mesh at close zoom.
