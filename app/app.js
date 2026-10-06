(() => {
  const $ = id => document.getElementById(id), C = $('scene'), X = C.getContext('2d');
  const AU = 149597870700, WARP = [1, 10, 100, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9], images = new Map(), keys = {};
  let D, P, A, F, S = {}, sel, craftSelected = false, lock = null, date = new Date('2026-10-05T12:00:00Z');
  let running = true, warpIndex = 0, lastFrame = performance.now(), simulationBacklog = 0, drag, terrain, mapRenderer, rcs = false;
  const cam = { o: { x: 0, y: 0 }, k: innerHeight / (2.5 * AU) };
  const icon = (name, path) => `<svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="${path}"/></svg>`;
  const rewindIcon = icon('rewind', 'm11 19-9-7 9-7v14Zm11 0-9-7 9-7v14Z');
  const forwardIcon = icon('forward', 'm13 5 9 7-9 7V5ZM2 5l9 7-9 7V5Z');
  const pauseIcon = icon('pause', 'M8 5v14M16 5v14');
  const playIcon = icon('play', 'm8 5 11 7-11 7V5Z');
  const img = src => { if (!images.has(src)) { const image = new Image(); image.src = '../' + src; images.set(src, image); } return images.get(src); };
  const ws = p => ({ x: innerWidth / 2 + (p.x - cam.o.x) * cam.k, y: innerHeight / 2 - (p.y - cam.o.y) * cam.k });
  const sw = (x, y) => ({ x: cam.o.x + (x - innerWidth / 2) / cam.k, y: cam.o.y - (y - innerHeight / 2) / cam.k });
  const finite = n => Number.isFinite(n);
  const number = n => !finite(n) ? '—' : n > 1e9 ? `${(n / 1e9).toFixed(2)}G` : n > 1e6 ? `${(n / 1e6).toFixed(2)}M` : n > 1e3 ? `${(n / 1e3).toFixed(1)}k` : n.toFixed(1);
  const altitude = n => `${number(Math.max(0, n) / 1000)} km`;
  const warpText = n => n >= 1e9 ? `${n / 1e9}B×` : n >= 1e6 ? `${n / 1e6}M×` : n >= 1e3 ? `${n / 1e3}k×` : `${n}×`;
  const setThrottle = value => { const level = Math.max(0, Math.min(100, Math.round(+value))); if (F) F.s.throttle = level / 100; $('throttle').value = String(level); $('throttleReadout').textContent = `${level}%`; $('throttleDial').style.setProperty('--lvl', level); };
  const rotationHours = { sun: 609.12, mercury: 1407.6, venus: -5832.5, earth: 23.934, mars: 24.623, jupiter: 9.925, saturn: 10.656, uranus: -17.24, neptune: 16.11, pluto: -153.3, ceres: 9.07, haumea: 3.915, makemake: 22.5, eris: 25.9 };
  const rotationAngle = body => ((+date - Date.parse('2000-01-01T12:00:00Z')) / 3600000 / (rotationHours[body.id] || 24)) * Math.PI * 2;

  function resize() { const d = Math.min(3, devicePixelRatio || 1); C.width = innerWidth * d; C.height = innerHeight * d; X.setTransform(d, 0, 0, d, 0, 0); X.imageSmoothingEnabled = true; X.imageSmoothingQuality = 'high'; }
  async function updateStates() {
    const nextDate = new Date(+date + 1000), [positions, nextPositions] = await Promise.all([ExolineOrbit.positions(date), ExolineOrbit.positions(nextDate)]);
    S = { sun: { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 } };
    for (const [id, point] of Object.entries(positions)) { const next = nextPositions[id]; S[id] = { x: point.x * AU, y: point.y * AU, z: point.z * AU, vx: (next.x - point.x) * AU, vy: (next.y - point.y) * AU, vz: (next.z - point.z) * AU }; }
    for (const moon of D.bodies.filter(body => body.kind === 'major_moon')) {
      const [point, next] = await Promise.all([ExolineOrbit.moon(moon.id, date), ExolineOrbit.moon(moon.id, nextDate)]), parent = D.bodies.find(body => body.name === moon.parent), host = S[parent.id];
      S[moon.id] = { x: host.x + point.x * AU, y: host.y + point.y * AU, z: host.z + point.z * AU, vx: host.vx + (next.x - point.x) * AU, vy: host.vy + (next.y - point.y) * AU, vz: host.vz + (next.z - point.z) * AU };
    }
  }
  function radiusOf(body) { return Math.max(1.3, P.bodies[body.id].radius_m * cam.k); }
  function orbit(id) {
    const body = D.bodies.find(item => item.id === id), parent = body?.parent && S[D.bodies.find(item => item.name === body.parent).id];
    const points = id.includes(':') ? ExolineOrbit.moonOrbitPath(id, 192, date) : ExolineOrbit.orbitPath(id, 384, date);
    X.beginPath(); points.forEach((point, index) => { const p = ws({ x: point.x * AU + (parent?.x || 0), y: point.y * AU + (parent?.y || 0) }); index ? X.lineTo(p.x, p.y) : X.moveTo(p.x, p.y); }); X.closePath(); X.strokeStyle = id === sel?.id ? '#78e5ff' : 'rgba(110,170,190,.20)'; X.lineWidth = id === sel?.id ? 1.5 : .7; X.stroke();
  }
  function atmosphere(body, screen, surfaceRadius, night) {
    const present = body.type === 'gas_giant' || body.type === 'ice_giant' || ['earth', 'venus', 'jupiter:europa', 'saturn:titan'].includes(body.id);
    if (!present || surfaceRadius <= 2) return;
    const colour = body.type === 'gas_giant' ? '255,203,158' : body.type === 'ice_giant' ? '163,216,229' : body.id === 'venus' ? '235,192,141' : '139,193,207';
    const overlap = Math.max(1.25, surfaceRadius * .014), innerRadius = Math.max(0, surfaceRadius - overlap), outerRadius = surfaceRadius + Math.max(2, surfaceRadius * .072);
    // Slightly overlap the raster edge to conceal pixel breakup, then fade past the surface.
    X.save(); X.beginPath(); X.arc(screen.x, screen.y, outerRadius, 0, Math.PI * 2); X.arc(screen.x, screen.y, innerRadius, 0, Math.PI * 2, true); X.clip();
    const haze = X.createRadialGradient(screen.x, screen.y, innerRadius, screen.x, screen.y, outerRadius); haze.addColorStop(0, `rgba(${colour},1)`); haze.addColorStop(.45, `rgba(${colour},.72)`); haze.addColorStop(1, `rgba(${colour},0)`); X.fillStyle = haze; X.fillRect(screen.x - outerRadius, screen.y - outerRadius, outerRadius * 2, outerRadius * 2); X.restore();
    // Re-apply the surface's solar terminator over the haze so the atmosphere also falls dark across the night side.
    if (night) { X.save(); X.beginPath(); X.arc(screen.x, screen.y, outerRadius, 0, Math.PI * 2); X.arc(screen.x, screen.y, innerRadius, 0, Math.PI * 2, true); X.clip(); X.fillStyle = night; X.fillRect(screen.x - outerRadius, screen.y - outerRadius, outerRadius * 2, outerRadius * 2); X.restore(); }
  }
  function body(body, point) {
    const screen = ws(point), radius = radiusOf(body), anchor = A[body.id] || A.default || { anchor_x: .5, anchor_y: .5 }, surfaceRadius = radius * (anchor.disk_scale || .848), sprite = img(body.orbital_asset);
    if (sprite.complete && sprite.naturalWidth) { X.save(); X.translate(screen.x, screen.y); X.rotate(rotationAngle(body)); X.drawImage(sprite, -radius * 2 * anchor.anchor_x, -radius * 2 * anchor.anchor_y, radius * 2, radius * 2); X.restore(); }
    else { X.fillStyle = '#94abb4'; X.beginPath(); X.arc(screen.x, screen.y, radius, 0, Math.PI * 2); X.fill(); }
    if (body.id !== 'sun' && radius > 2) {
      const length = Math.hypot(point.x, point.y) || 1, lx = -point.x / length, ly = point.y / length;
      const night = X.createLinearGradient(screen.x - lx * radius * 1.35, screen.y - ly * radius * 1.35, screen.x + lx * radius * 1.35, screen.y + ly * radius * 1.35);
      night.addColorStop(0, 'rgba(0,2,9,.96)'); night.addColorStop(.42, 'rgba(0,4,14,.78)'); night.addColorStop(.56, 'rgba(2,10,20,.20)'); night.addColorStop(.68, 'rgba(0,0,0,0)');
      X.save(); X.beginPath(); X.arc(screen.x, screen.y, radius, 0, Math.PI * 2); X.clip(); X.fillStyle = night; X.fillRect(screen.x - radius, screen.y - radius, radius * 2, radius * 2); X.restore(); atmosphere(body, screen, surfaceRadius, night);
    }
    if (sel?.id === body.id) { X.strokeStyle = 'rgba(132,194,210,.55)'; X.lineWidth = 1; X.beginPath(); X.arc(screen.x, screen.y, Math.max(8, surfaceRadius + 2), 0, Math.PI * 2); X.stroke(); }
    if (radius > 12 || sel?.id === body.id) { X.fillStyle = '#e8f8ff'; X.font = '10px sans-serif'; X.fillText(body.name, screen.x + radius + 5, screen.y - 4); }
  }
  function marker(world, label, colour) { const p = ws(world); X.fillStyle = colour; X.beginPath(); X.arc(p.x, p.y, 4, 0, Math.PI * 2); X.fill(); X.fillStyle = '#e7f9ff'; X.font = '9px sans-serif'; X.fillText(label, p.x + 7, p.y - 7); }
  function drawEscape(relativeVelocity, periapsisPoint, periapsisAltitude) {
    const speed = Math.hypot(relativeVelocity.x, relativeVelocity.y) || 1, from = F.s.r, span = Math.hypot(innerWidth, innerHeight) * 1.25 / cam.k;
    const to = { x: from.x + relativeVelocity.x / speed * span, y: from.y + relativeVelocity.y / speed * span };
    const a = ws(from), b = ws(to); X.save(); X.setLineDash([7, 6]); X.strokeStyle = 'rgba(255,192,115,.92)'; X.lineWidth = 1.5; X.beginPath(); X.moveTo(a.x, a.y); X.lineTo(b.x, b.y); X.stroke(); X.setLineDash([]); X.fillStyle = '#ffcf9c'; X.font = '9px sans-serif'; X.fillText('ESCAPE', b.x - 42, b.y - 8); X.restore();
    if (finite(periapsisAltitude)) marker(periapsisPoint, `PE ${altitude(periapsisAltitude)}`, '#77edff');
  }
  function trajectory() {
    if (!craftSelected || !F || !S.sun) return;
    const d = F.diagnostics(S, sel?.id), center = S[d.body], physical = P.bodies[d.body], r = { x: F.s.r.x - center.x, y: F.s.r.y - center.y }, v = { x: F.s.v.x - center.vx, y: F.s.v.y - center.vy }, R = Math.hypot(r.x, r.y), mu = P.G * physical.mass, h = r.x * v.y - r.y * v.x;
    const ev = { x: (((v.x * v.x + v.y * v.y) - mu / R) * r.x - (r.x * v.x + r.y * v.y) * v.x) / mu, y: (((v.x * v.x + v.y * v.y) - mu / R) * r.y - (r.x * v.x + r.y * v.y) * v.y) / mu }, e = Math.hypot(ev.x, ev.y), p = h * h / mu;
    if (!finite(e) || !finite(p)) return;
    const ex = e > .00001 ? ev.x / e : r.x / R, ey = e > .00001 ? ev.y / e : r.y / R, peri = p / (1 + e);
    if (e >= 1) { drawEscape(v, { x: center.x + peri * ex, y: center.y + peri * ey }, peri - physical.radius_m); return; }
    X.beginPath(); for (let n = 0; n <= 240; n++) { const theta = n * Math.PI * 2 / 240, radial = p / (1 + e * Math.cos(theta)), point = ws({ x: center.x + radial * (ex * Math.cos(theta) - ey * Math.sin(theta)), y: center.y + radial * (ey * Math.cos(theta) + ex * Math.sin(theta)) }); n ? X.lineTo(point.x, point.y) : X.moveTo(point.x, point.y); } X.strokeStyle = 'rgba(92,232,255,.88)'; X.lineWidth = 1.3; X.stroke();
    const apo = p / (1 - e); marker({ x: center.x + peri * ex, y: center.y + peri * ey }, `PE ${altitude(peri - physical.radius_m)}`, '#77edff'); marker({ x: center.x - apo * ex, y: center.y - apo * ey }, `AP ${altitude(apo - physical.radius_m)}`, '#ffbd76');
  }
  function craft() { if (!F) return; const p = ws(F.s.r); X.save(); X.translate(p.x, p.y); X.rotate(-F.s.heading + Math.PI / 2); X.fillStyle = '#f8fdff'; X.strokeStyle = '#0b3040'; X.lineWidth = 2; X.beginPath(); X.moveTo(0, -15); X.lineTo(11, 11); X.lineTo(-11, 11); X.closePath(); X.fill(); X.stroke(); X.fillStyle = '#53ddff'; X.beginPath(); X.moveTo(0, -8); X.lineTo(3, 3); X.lineTo(-3, 3); X.closePath(); X.fill(); X.restore(); }
  function hud() { $('flightHud').classList.toggle('hidden', !craftSelected); if (!craftSelected || !F) return; const d = F.diagnostics(S, sel?.id), name = D.bodies.find(b => b.id === d.body)?.name || 'Sun'; $('hudSoi').textContent = name.toUpperCase(); $('hudAlt').textContent = d.alt < 10000 ? `${Math.round(d.alt)} m` : `${(d.alt / 1000).toFixed(1)} km`; $('hudVel').textContent = d.speed < 1000 ? `${d.speed.toFixed(1)} m/s` : `${Math.round(d.speed).toLocaleString('en-US')} m/s`; $('hudApo').textContent = altitude(d.apo); $('hudPeri').textContent = altitude(d.peri); $('hudEcc').textContent = d.e.toFixed(4); $('hudDistance').textContent = altitude(d.target); $('launchBtn').textContent = F.s.throttle > 0 ? 'CUTOFF' : 'IGNITION'; }
  function vehicleReadout() { if (!F) return; $('shipMass').textContent = `${(F.s.m / 1000).toFixed(2)} t`; $('shipThrust').textContent = `${(F.thrust / 1000).toFixed(0)} kN`; $('shipTwr').textContent = (F.thrust * Math.max(F.s.throttle, .01) / (F.s.m * 9.80665)).toFixed(2); }
  function updateWarp() { const button = $('warpBtn'); button.innerHTML = `${running ? pauseIcon : playIcon}<span>${running ? warpText(WARP[warpIndex]) : ''}</span>`; button.classList.toggle('is-paused', !running); button.setAttribute('aria-label', running ? `Pause at ${warpText(WARP[warpIndex])}` : 'Resume simulation'); }
  function setWarp(index) { warpIndex = Math.max(0, Math.min(WARP.length - 1, index)); simulationBacklog = 0; updateWarp(); }
  function follow() { if (lock === 'craft' && F) cam.o = { x: F.s.r.x, y: F.s.r.y }; else if (lock === 'body' && sel && S[sel.id]) cam.o = { x: S[sel.id].x, y: S[sel.id].y }; }
  function draw() { follow(); X.fillStyle = '#02070c'; X.fillRect(0, 0, innerWidth, innerHeight); for (let i = 0; i < 140; i++) { X.fillStyle = 'rgba(190,230,250,.25)'; X.fillRect((i * 197) % innerWidth, (i * 89) % innerHeight, 1, 1); } if (!D) return; D.bodies.forEach(b => orbit(b.id)); body({ id: 'sun', name: 'Sun', orbital_asset: D.sun.asset }, S.sun); D.bodies.forEach(b => body(b, S[b.id])); trajectory(); craft(); hud(); vehicleReadout(); $('simDate').textContent = date.toISOString().replace('T', ' ').slice(0, 19) + ' UTC'; updateWarp(); }
  function inspect(body) { sel = body; craftSelected = false; lock = 'body'; $('detailPanel').classList.remove('hidden'); $('detailName').textContent = body.name; $('detailKicker').textContent = 'CELESTIAL BODY'; $('detailSub').textContent = body.parent ? `MOON OF ${body.parent.toUpperCase()}` : 'SOL SYSTEM'; $('detailType').textContent = body.type; $('detailOrbit').textContent = body.kind === 'major_moon' ? 'LOCAL ORBIT' : 'HELIOCENTRIC'; $('detailPeriod').textContent = 'LIVE STATE'; $('detailSeed').textContent = body.seed || '—'; $('detailNote').textContent = 'Orbital position and rendered orbit use the same propagated Keplerian state.'; cam.o = { x: S[body.id].x, y: S[body.id].y }; cam.k = Math.max(cam.k, 24 / P.bodies[body.id].radius_m); }
  function pick(x, y) { let chosen, best = Infinity; for (const body of D.bodies) { const p = ws(S[body.id]), anchor = A[body.id] || A.default || {}, r = Math.max(9, radiusOf(body) * (anchor.disk_scale || .848)), score = Math.hypot(p.x - x, p.y - y) / r; if (score <= 1 && score < best) { chosen = body; best = score; } } return chosen; }
  async function openMap() { if (!sel) return; terrain ??= await (await fetch('../data/terrain_manifest.json')).json(); const manifest = terrain.bodies[sel.id]; if (!manifest) return; C.style.display = 'none'; $('mapCanvas').classList.remove('hidden'); $('mapCanvas').style.display = 'block'; $('mapTopbar').classList.remove('hidden'); if (!mapRenderer) mapRenderer = new ExolineMap.MapRenderer($('mapCanvas'), { terrainManifest: manifest, onZoom: zoom => { $('mapReadout').textContent = `MAP · ${zoom.toFixed(1)}×`; } }); await mapRenderer.open(sel, manifest); }
  function closeMission() { $('missionScreen').classList.add('hidden'); $('app').classList.remove('mission-active'); }
  function renderChangelog(markdown) { const target = $('changelogContent'); target.replaceChildren(); let list; for (const line of markdown.split(/\r?\n/)) { if (line.startsWith('### ')) { list = null; const heading = document.createElement('h2'); heading.textContent = line.slice(4); target.append(heading); } else if (line.startsWith('- ')) { if (!list) { list = document.createElement('ul'); target.append(list); } const item = document.createElement('li'); item.textContent = line.slice(2); list.append(item); } else if (line.trim()) { list = null; const paragraph = document.createElement('p'); paragraph.textContent = line.replace(/^# /, ''); target.append(paragraph); } else list = null; } }
  function controls() {
    $('exploreSolBtn').onclick = closeMission; $('continueMissionBtn').onclick = closeMission; $('missionEnter').onclick = closeMission; $('newCampaignBtn').onclick = () => { F.launch('earth', S); cam.o = { x: F.s.r.x, y: F.s.r.y }; closeMission(); };
    $('changelogBtn').onclick = async () => { $('changelogPanel').classList.remove('hidden'); try { renderChangelog(await (await fetch('../version_change.md', { cache: 'no-store' })).text()); } catch { $('changelogContent').textContent = 'Unable to load version_change.md'; } }; $('closeChangelog').onclick = () => $('changelogPanel').classList.add('hidden');
    $('slower').innerHTML = rewindIcon; $('faster').innerHTML = forwardIcon; $('slower').onclick = e => { e.preventDefault(); e.stopPropagation(); setWarp(warpIndex - 1); }; $('faster').onclick = e => { e.preventDefault(); e.stopPropagation(); setWarp(warpIndex + 1); }; $('warpBtn').onclick = e => { e.preventDefault(); e.stopPropagation(); running = !running; updateWarp(); };
    $('throttle').oninput = e => setThrottle(e.target.value); $('turnLeft').onpointerdown = () => keys.right = true; $('turnRight').onpointerdown = () => keys.left = true; addEventListener('pointerup', () => { keys.left = false; keys.right = false; });
    $('launchBtn').onclick = () => { craftSelected = true; lock = 'craft'; sel = null; setThrottle(F.s.throttle > 0 ? 0 : 100); $('launchBtn').textContent = F.s.throttle ? 'CUTOFF' : 'IGNITION'; }; $('rcsBtn').onclick = () => { rcs = !rcs; $('rcsBtn').classList.toggle('is-on', rcs); $('rcsBtn').setAttribute('aria-pressed', String(rcs)); };
    $('resetBtn').onclick = () => { lock = null; cam.o = { x: 0, y: 0 }; cam.k = innerHeight / (2.5 * AU); }; $('closeDetail').onclick = () => { $('detailPanel').classList.add('hidden'); sel = null; lock = null; }; $('openMapBtn').onclick = openMap; $('mapResetBtn').onclick = () => mapRenderer?.reset(); $('backBtn').onclick = () => { C.style.display = 'block'; $('mapCanvas').style.display = 'none'; $('mapCanvas').classList.add('hidden'); $('mapTopbar').classList.add('hidden'); };

    C.addEventListener('pointerdown', e => { const r = C.getBoundingClientRect(); drag = { x: e.clientX - r.left, y: e.clientY - r.top, o: { ...cam.o } }; C.setPointerCapture(e.pointerId); }); C.addEventListener('pointermove', e => { if (!drag) return; const r = C.getBoundingClientRect(), dx = e.clientX - r.left - drag.x, dy = e.clientY - r.top - drag.y; if (Math.hypot(dx, dy) > 7) lock = null; cam.o = { x: drag.o.x - dx / cam.k, y: drag.o.y + dy / cam.k }; }); C.addEventListener('pointerup', e => { const r = C.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top, moved = drag && Math.hypot(x - drag.x, y - drag.y) >= 7; drag = null; if (moved) return; const ship = ws(F.s.r), hit = pick(x, y); if (Math.hypot(ship.x - x, ship.y - y) < 22) { craftSelected = true; sel = null; lock = 'craft'; $('detailPanel').classList.add('hidden'); } else if (hit) inspect(hit); else { sel = null; craftSelected = false; lock = null; $('detailPanel').classList.add('hidden'); } }); C.addEventListener('wheel', e => { e.preventDefault(); const r = C.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top, before = sw(x, y), factor = e.deltaY < 0 ? 1.22 : 1 / 1.22; cam.k = Math.max(1e-12, cam.k * factor); if (!lock) { const after = sw(x, y); cam.o.x += before.x - after.x; cam.o.y += before.y - after.y; } }, { passive: false });
    addEventListener('keydown', e => { if (e.code === 'Space') { e.preventDefault(); running = !running; updateWarp(); } if (e.key === '[') setWarp(warpIndex - 1); if (e.key === ']') setWarp(warpIndex + 1); if (['ArrowLeft', 'a'].includes(e.key)) keys.left = true; if (['ArrowRight', 'd'].includes(e.key)) keys.right = true; }); addEventListener('keyup', () => { keys.left = false; keys.right = false; });
  }
  async function frame(now) { const realSeconds = Math.min(.1, (now - lastFrame) / 1000); lastFrame = now; if (running) { const requestedSeconds = realSeconds * WARP[warpIndex]; F.s.heading += (Number(!!keys.right) - Number(!!keys.left)) * (rcs ? .7 : 2.2) * realSeconds; try { F.step(Math.min(5, requestedSeconds), S); date = new Date(+date + requestedSeconds * 1000); await updateStates(); F.syncCircularHold(S); } catch (error) { console.warn('Flight integration paused:', error); running = false; simulationBacklog = 0; } } draw(); requestAnimationFrame(frame); }
  async function start() { [D, P, A] = await Promise.all(['solar_system.json', 'physics_constants.json', 'render_anchors.json'].map(async file => (await fetch('../data/' + file)).json())); await ExolineOrbit.load(); await updateStates(); F = new ExolineFlight.Flight(P); F.launch('earth', S); resize(); controls(); setWarp(0); setTimeout(() => { $('introScreen')?.classList.add('is-exiting'); setTimeout(() => { $('introScreen')?.remove(); $('missionScreen')?.classList.remove('hidden'); $('app')?.classList.add('mission-active'); }, 850); }, 4200); requestAnimationFrame(frame); }
  addEventListener('resize', resize); start().catch(console.error);
})();
