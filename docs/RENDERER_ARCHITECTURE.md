# Renderer Architecture

## System view
The renderer converts Keplerian orbital state into ecliptic top-down coordinates. Physical radius and speed are preserved by the orbital model; the screen uses a log/power visual scale so the whole Solar System can be explored in one viewport.

## Planet map
The renderer loads the dataset's `surface_asset` and progressively uses the matching `terrain/z*` PNG tiles. This is a pixel-oriented 2:1 map. X wraps; Y clamps.

## Separation
Terrain, celestial bodies, and future gameplay overlays remain separate. Resources, hazards, colonies, roads, and buildings should be rendered as data-driven overlays in later versions.
