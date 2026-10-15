#!/usr/bin/env python3
"""Regenerate Earth's equirectangular surface map and its terrain tile pyramid.

Why this exists
---------------
The original `assets/surface/earth/earth_surface.png` is a 512x256 field of
low-frequency noise blobs (two tones: teal ocean, green speckle) and the
`assets/terrain/earth/z0..z2` "tiles" were just re-cuts of that same 512px
image, so deep zoom only ever magnified a handful of pixels. This script
builds a proper planet instead: continents with fractal coastlines, ocean
depth and shallow shelves, a Whittaker biome blend driven by temperature and
moisture, polar ice, and hill-shaded relief, all sampled at 4096x2048 and
sliced into a 128px tile pyramid that reaches native resolution.

Everything is deterministic (fixed seed) so the committed PNGs are
reproducible. Run from the repository root:

    python tools/generate_earth_surface.py

Outputs
-------
    assets/surface/earth/earth_surface.png          master, 4096x2048
    assets/terrain/earth/z{L}/x{x}_y{y}.png         128px tiles, L = 0..5
    data/terrain_manifest.json                      earth entry rewritten
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]

# Longitude must wrap seamlessly on an equirectangular map, so the field is
# generated at 2:1 and every noise octave is periodic in x.
W, H = 4096, 2048
SEED = 862331856  # earth's seed in data/solar_system.json
LAND_FRACTION = 0.42  # "also add more land" (the old map was ~0.13)
MAX_LEVEL = 5  # z5 = 32x16 tiles of 128px = 4096px across, i.e. native
TILE = 128

rng = np.random.default_rng(SEED)


def value_noise(gw: int, gh: int) -> np.ndarray:
    """Smooth bilinear value noise on the full grid, periodic along x."""
    gw = max(1, gw)
    gh = max(1, gh)
    grid = rng.random((gh, gw))
    xs = (np.arange(W, dtype=np.float64) + 0.5) / W * gw
    ys = (np.arange(H, dtype=np.float64) + 0.5) / H * gh
    xf = np.floor(xs)
    yf = np.floor(ys)
    x0 = xf.astype(np.int64) % gw
    y0 = yf.astype(np.int64) % gh
    x1 = (x0 + 1) % gw
    y1 = (y0 + 1) % gh
    tx, ty = xs - xf, ys - yf
    sx = tx * tx * (3 - 2 * tx)
    sy = ty * ty * (3 - 2 * ty)
    a = grid[np.ix_(y0, x0)]
    b = grid[np.ix_(y0, x1)]
    c = grid[np.ix_(y1, x0)]
    d = grid[np.ix_(y1, x1)]
    top = a + (b - a) * sx[None, :]
    bot = c + (d - c) * sx[None, :]
    return top + (bot - top) * sy[:, None]


def fbm(gw: int, gh: int, octaves: int, gain: float = 0.5) -> np.ndarray:
    """Fractal Brownian motion over `octaves` doubling frequencies."""
    total = np.zeros((H, W), dtype=np.float64)
    amp, freq, norm = 1.0, 1.0, 0.0
    for _ in range(octaves):
        total += amp * value_noise(int(gw * freq), int(gh * freq))
        norm += amp
        amp *= gain
        freq *= 2
    return total / norm


def norm01(a: np.ndarray) -> np.ndarray:
    lo, hi = float(a.min()), float(a.max())
    return (a - lo) / max(1e-9, hi - lo)


def smoothstep(edge0: float, edge1: float, x: np.ndarray) -> np.ndarray:
    t = np.clip((x - edge0) / (edge1 - edge0 if edge1 != edge0 else 1e-9), 0.0, 1.0)
    return t * t * (3 - 2 * t)


print("generating noise fields ...")
continents = norm01(fbm(6, 3, 6, gain=0.55))
detail = norm01(fbm(28, 14, 7))
moisture_noise = norm01(fbm(11, 6, 6))
micro = norm01(fbm(220, 110, 3))  # fine texture so deep zoom never reads flat

lat = 90.0 - (np.arange(H, dtype=np.float64) + 0.5) / H * 180.0
lat_row = np.abs(lat)[:, None]

# Land/sea split, then STRETCH the height and depth to their own full range.
# Without that stretch the fbm sum is so peaked around its mean that almost
# every ocean pixel lands a hair under the threshold and the whole sea renders
# as one flat continental shelf.
elevation = norm01(0.78 * continents + 0.22 * detail)
sea = float(np.quantile(elevation, 1.0 - LAND_FRACTION))
land = elevation > sea
ocean_floor = float(elevation.min())
peak = float(elevation.max())
depth = np.clip((sea - elevation) / max(1e-9, sea - ocean_floor), 0.0, 1.0)
land_height = np.clip((elevation - sea) / max(1e-9, peak - sea), 0.0, 1.0)
print(f"land fraction: {float(land.mean()):.3f}")

# Temperature: hot at the equator, frozen at the poles, colder with altitude.
temperature = np.clip(
    1.06
    - (lat_row / 90.0) * 1.16
    - 0.28 * land_height
    + (norm01(fbm(7, 4, 4)) - 0.5) * 0.08,
    0.0,
    1.0,
)

# Moisture: wet at the equator (rainforest) and in the temperate belt, dry in
# the subtropical bands (deserts), plus a good dose of noise for variety.
equator_wet = np.exp(-((lat_row - 2.0) / 15.0) ** 2)
subtropic_dry = np.exp(-((lat_row - 26.0) / 13.0) ** 2)
temperate_wet = np.exp(-((lat_row - 52.0) / 20.0) ** 2)
lat_moist = 0.52 + 0.34 * equator_wet - 0.46 * subtropic_dry + 0.14 * temperate_wet
moist = np.clip(
    0.42 * moisture_noise + 0.58 * lat_moist - 0.16 * land_height,
    0.0,
    1.0,
)

# Whittaker-style biome prototypes in (temperature, moisture) space.
BIOMES = [
    # (t, m, colour)          colour is the flat map tone of the biome
    (0.14, 0.48, (150, 152, 140)),  # tundra
    (0.30, 0.62, (56, 92, 64)),     # taiga
    (0.50, 0.78, (54, 110, 52)),    # temperate forest
    (0.52, 0.34, (134, 150, 78)),   # grassland
    (0.80, 0.04, (214, 190, 134)),  # desert
    (0.84, 0.44, (166, 154, 74)),   # savanna
    (0.96, 0.90, (20, 92, 40)),     # tropical rainforest
]
SIGMA_T, SIGMA_M = 0.24, 0.24

print("blending biomes ...")
color = np.zeros((H, W, 3), dtype=np.float64)
wsum = np.zeros((H, W), dtype=np.float64)
for ti, mi, col in BIOMES:
    w = np.exp(
        -(((temperature - ti) ** 2) / (2 * SIGMA_T ** 2)
          + ((moist - mi) ** 2) / (2 * SIGMA_M ** 2))
    )
    color += w[:, :, None] * np.asarray(col, dtype=np.float64)[None, None, :]
    wsum += w
color /= np.maximum(1e-9, wsum)[:, :, None]

print("painting oceans ...")
DEEP = np.asarray((10, 42, 78), dtype=np.float64)
MID = np.asarray((26, 96, 132), dtype=np.float64)
SHALLOW = np.asarray((78, 160, 188), dtype=np.float64)
# Two-stop ramp: very deep basins -> mid ocean -> bright shelf water.
ocean = DEEP + (MID - DEEP) * np.clip(depth / 0.6, 0, 1)[:, :, None]
ocean = ocean + (SHALLOW - ocean) * smoothstep(0.85, 1.0, 1.0 - depth)[:, :, None]
ocean *= (0.95 + 0.10 * micro)[:, :, None]

print("painting land relief ...")
ROCK = np.asarray((118, 110, 100), dtype=np.float64)
SNOW = np.asarray((234, 240, 248), dtype=np.float64)
SAND = np.asarray((204, 188, 142), dtype=np.float64)

landcol = color
# Coastal sand strip on low, gentle ground.
sandy = smoothstep(0.06, 0.0, land_height)[:, :, None]
landcol = landcol * (1.0 - sandy) + SAND * sandy
# Bare rock on the high ground, snow above the snow line.
rocky = smoothstep(0.50, 0.72, land_height)[:, :, None]
landcol = landcol * (1.0 - rocky) + ROCK * rocky
snow_line = smoothstep(0.40, 0.62, land_height) * smoothstep(0.45, 0.03, temperature)
altitude_snow = smoothstep(0.74, 0.94, land_height)
snowy = np.clip(snow_line + altitude_snow, 0, 1)[:, :, None]
landcol = landcol * (1.0 - snowy) + SNOW * snowy

# Polar sea ice with a noisy edge; land ice is already handled by the
# temperature term feeding the snow blend above.
ice_edge = 70.0 + (norm01(fbm(9, 5, 4)) - 0.5) * 6.0
ocean = np.where(
    ((lat_row > ice_edge) & (micro < 0.62))[:, :, None],
    ocean * 0.32 + SNOW * 0.68,
    ocean,
)

print("shading ...")
# Hillshade from the terrain gradient: the single biggest cue that makes a map
# read as *sharp* rather than as a flat wash. Light comes from the north-west.
gy, gx = np.gradient(elevation)
shade = np.clip(1.0 + (-gx * 0.9 - gy * 0.9) * 22.0, 0.70, 1.30)[:, :, None]
landcol = np.clip(landcol * shade, 0, 255)

# Fine speckle everywhere breaks residual banding once magnified.
speckle = ((micro - 0.5) * 20.0)[:, :, None]

out = np.where(land[:, :, None], landcol, ocean) + speckle
out = np.clip(out, 0, 255).astype(np.uint8)

master = Image.fromarray(out, "RGB")

print("writing master ...")
master_path = ROOT / "assets/surface/earth/earth_surface.png"
master.save(master_path, optimize=True)


def tile_box(level: int, x: int, y: int) -> tuple[int, int, int, int]:
    tx = 1 << level
    ty = (1 << (level - 1)) if level >= 1 else 1
    return (
        round(x * W / tx),
        round(y * H / ty),
        round((x + 1) * W / tx),
        round((y + 1) * H / ty),
    )


print("slicing tile pyramid ...")
levels: dict[str, dict] = {}
for level in range(MAX_LEVEL + 1):
    tx = 1 << level
    ty = (1 << (level - 1)) if level >= 1 else 1
    tiles = []
    for y in range(ty):
        for x in range(tx):
            x0, y0, x1, y1 = tile_box(level, x, y)
            region = master.crop((x0, y0, x1, y1))
            if region.size != (TILE, TILE):
                region = region.resize((TILE, TILE), Image.BOX)  # area average
            rel = f"assets/terrain/earth/z{level}/x{x}_y{y}.png"
            dest = ROOT / rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            region.save(dest, optimize=True)
            tiles.append({"x": x, "y": y, "path": rel})
    levels[str(level)] = {"tiles_x": tx, "tiles_y": ty, "tiles": tiles}
    print(f"  z{level}: {tx}x{ty} = {len(tiles)} tiles")

print("updating terrain manifest ...")
manifest_path = ROOT / "data/terrain_manifest.json"
manifest = json.loads(manifest_path.read_text())
manifest["version"] = "0.2.0-earth-hires"
manifest["tile_size"] = TILE
manifest["bodies"]["earth"].update(
    {
        "master": "assets/surface/earth/earth_surface.png",
        "levels": levels,
        "wrap_x": True,
        "wrap_y": False,
        "master_width": W,
        "master_height": H,
    }
)
manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
print("done.")
