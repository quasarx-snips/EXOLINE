# EXOLINE v0.0.2 — Phase 1 Solar System

Goal: make the Solar System itself the first complete explorable EXOLINE world.

## Scope
- Sun
- Mercury, Venus, Earth, Mars, Jupiter, Saturn, Uranus, Neptune
- Pluto
- Ceres, Haumea, Makemake, Eris as major dwarf-planet entries
- curated major/strategic moons: 21
- asteroid belt, Kuiper Belt, Oort Cloud region
- planet/moon orbital previews
- planar pixel surface maps
- mineral/resource profiles
- deterministic asset IDs and seeds

## Rendering principles
- System view is a map/navigation view.
- Surface map is deliberately planar for v0.0.2; curvature and day/night surface shading are deferred.
- Surface pixels are intentionally blocky under zoom (nearest-neighbor presentation); later versions can move to streamed high-res LOD tiles.
- Orbital images use spherical lighting, but surface maps do not yet use a sun terminator.
- Entity/building LOD is a later phase: distant icon -> intermediate sprite -> close building model.

## OpenFront inspiration
We use only public conceptual patterns: separate map terrain and entity layers, camera zoom/pan, and zoom-dependent structure rendering. No OpenFront proprietary code/assets are included.
