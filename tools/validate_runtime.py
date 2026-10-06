import json, os, sys
from pathlib import Path
from PIL import Image
ROOT=Path(__file__).resolve().parents[1]
D=json.loads((ROOT/'data/solar_system.json').read_text())
T=json.loads((ROOT/'data/terrain_manifest.json').read_text())
P=json.loads((ROOT/'data/physics_constants.json').read_text())
errors=[]
for b in D['bodies']:
    physical=P['bodies'].get(b['id'])
    if not physical or physical.get('mass',0)<=0 or physical.get('radius_m',0)<=0:
        errors.append(f'missing/invalid physics record: {b["id"]}')
    if b.get('parent') and not any(x['name']==b['parent'] for x in D['bodies']):
        errors.append(f'invalid SOI parent: {b["id"]} -> {b["parent"]}')
    for k in ('orbital_asset','surface_asset'):
        p=ROOT/b[k]
        if not p.exists(): errors.append(f'missing {k}: {p}')
        else:
            try:
                im=Image.open(p); im.verify()
            except Exception as e: errors.append(f'bad image {p}: {e}')
    if b['id'] not in T['bodies']:
        errors.append(f'missing terrain manifest: {b["id"]}')
    else:
        tm=T['bodies'][b['id']]
        for z,lv in tm['levels'].items():
            for tile in lv['tiles']:
                p=ROOT/tile['path']
                if not p.exists(): errors.append(f'missing tile {p}')
                else:
                    try:
                        im=Image.open(p); im.verify()
                    except Exception as e: errors.append(f'bad tile {p}: {e}')
print(f'Bodies: {len(D["bodies"])}')
print(f'Terrain bodies: {len(T["bodies"])}')
print(f'Errors: {len(errors)}')
for e in errors[:100]: print('ERROR:',e)
sys.exit(1 if errors else 0)
