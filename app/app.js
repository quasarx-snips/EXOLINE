(() => {
  const $ = id => document.getElementById(id), C = $('scene'), X = C.getContext('2d');
  const AU = 149597870700, WARP = [1, 10, 100, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9], images = new Map(), keys = {};
  let D, P, A, minerals = null, F, S = {}, sel, craftSelected = false, lock = null, date = new Date('2026-10-05T12:00:00Z');
  let running = true, warpIndex = 0, lastFrame = performance.now(), simulationBacklog = 0, drag, terrain, mapRenderer, rcs = false, frameCount = 0;
  let panning = false, panDrag = { x: 0, y: 0 }, panned = false;
  keys.pan = { up: false, down: false, left: false, right: false };
  let navSnap = null, activeNodeId = null, toastTimer = 0, autoBurn = null, nodeHitRegions = [], orbitHitRegions = [];
  const nodeAnchors = new Map();
  const defaultBindings = { pause: 'Space', warpDown: 'BracketLeft', warpUp: 'BracketRight', focusCraft: 'KeyF', resetView: 'KeyR', addNode: 'KeyN', autoBurn: 'KeyB' };
  let bindings = { ...defaultBindings };
  try { bindings = { ...defaultBindings, ...JSON.parse(localStorage.getItem('exoline.keybinds') || '{}') }; } catch { /* use defaults */ }
  const bindingLabel = code => code === 'Space' ? 'Space' : code.replace(/^Key/, '').replace(/^Digit/, '');
  const matches = (event, action) => event.code === bindings[action];
  const cam = { o: { x: 0, y: 0 }, k: innerHeight / (2.5 * AU) };
  const icon = (name, path) => `<svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="${path}"/></svg>`;
  const rewindIcon = icon('rewind', 'm11 19-9-7 9-7v14Zm11 0-9-7 9-7v14Z');
  const forwardIcon = icon('forward', 'm13 5 9 7-9 7V5ZM2 5l9 7-9 7V5Z');
  const pauseIcon = icon('pause', 'M8 5v14M16 5v14');
  const playIcon = icon('play', 'm8 5 11 7-11 7V5Z');
  const img = src => { if (!images.has(src)) { const image = new Image(); image.src = '../' + src; images.set(src, image); } return images.get(src); };
  const ws = p => ({ x: innerWidth / 2 + (p.x - cam.o.x) * cam.k, y: innerHeight / 2 - (p.y - cam.o.y) * cam.k });
  const sw = (x, y) => ({ x: cam.o.x + (x - innerWidth / 2) / cam.k, y: cam.o.y - (y - innerHeight / 2) / cam.k });
  const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: (a.z || 0) - (b.z || 0) });
  const len = a => Math.hypot(a.x, a.y, a.z || 0);
  const finite = n => Number.isFinite(n);
  // Curve tessellation: enough segments that no chord exceeds ~6 px on screen,
  // so ellipses never read as polylines at any zoom. Bounded for perf.
  const smoothCount = (worldLen, min, max) => Math.max(min, Math.min(max, Math.ceil(worldLen * cam.k / 6)));
  const ellipsePerimeter = (a, b) => Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b)));

  // Local frame of the body the craft is currently sitting inside (if any).
  // Outside an SOI the transform is the identity, so draw routines keep
  // behaving in the solar-system frame; inside one, conics/escape paths are
  // drawn around the body that owns the SOI the craft has just entered.
  let currentSoi = null; // { id, dist, soi } | null
  const t = p => currentSoi ? { x: p.x - S[currentSoi.id].x, y: p.y - S[currentSoi.id].y } : p;

  // Body whose sphere of influence the craft is currently inside, or null.
  function soiBody() {
    if (!craftSelected || !F) return null;
    // SOI is a navigation classification, not the body exerting the largest
    // instantaneous pull. Gravity dominance can switch well inside a nominal
    // SOI, which previously made local navigation flicker during escape.
    let selected = null;
    for (const body of D?.bodies || []) {
      if (!S[body.id]) continue;
      const soi = ExolineNav.soiRadius(body.id);
      if (!finite(soi) || soi <= 0) continue;
      const dist = len(sub(F.s.r, S[body.id]));
      if (dist > soi) continue;
      if (!selected || soi < selected.soi) selected = { id: body.id, dist, soi };
    }
    return selected;
  }
  const number = n => !finite(n) ? '—' : n > 1e9 ? `${(n / 1e9).toFixed(2)}G` : n > 1e6 ? `${(n / 1e6).toFixed(2)}M` : n > 1e3 ? `${(n / 1e3).toFixed(1)}k` : n.toFixed(1);
  const altitude = n => `${number(Math.max(0, n) / 1000)} km`;
  const warpText = n => n >= 1e9 ? `${n / 1e9}B×` : n >= 1e6 ? `${n / 1e6}M×` : n >= 1e3 ? `${n / 1e3}k×` : `${n}×`;
  const setText = (id, value) => { const el = $(id); if (el && el.textContent !== value) el.textContent = value; };
  function showToast(message) { const el = $('toast'); if (!el) return; el.textContent = message; el.style.opacity = '1'; clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.style.opacity = '0'; }, 2300); }
  const setThrottle = (value, automated = false) => { if (autoBurn && !automated) return; const level = Math.max(0, Math.min(100, Math.round(+value))); if (F) F.s.throttle = level / 100; $('throttle').value = String(level); $('throttleReadout').textContent = `${level}%`; $('throttleDial').style.setProperty('--lvl', level); };
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
  function body(body, point) {
    const screen = ws(point), radius = radiusOf(body), anchor = A[body.id] || A.default || { anchor_x: .5, anchor_y: .5 }, surfaceRadius = radius * (anchor.disk_scale || .848), sprite = img(body.orbital_asset);
    if (sprite.complete && sprite.naturalWidth) { X.save(); X.translate(screen.x, screen.y); X.rotate(rotationAngle(body)); X.drawImage(sprite, -radius * 2 * anchor.anchor_x, -radius * 2 * anchor.anchor_y, radius * 2, radius * 2); X.restore(); }
    else { X.fillStyle = '#94abb4'; X.beginPath(); X.arc(screen.x, screen.y, radius, 0, Math.PI * 2); X.fill(); }
    if (body.id !== 'sun' && radius > 2) {
      const length = Math.hypot(point.x, point.y) || 1, lx = -point.x / length, ly = point.y / length;
      const night = X.createLinearGradient(screen.x - lx * radius * 1.35, screen.y - ly * radius * 1.35, screen.x + lx * radius * 1.35, screen.y + ly * radius * 1.35);
      night.addColorStop(0, 'rgba(0,2,9,.96)'); night.addColorStop(.42, 'rgba(0,4,14,.78)'); night.addColorStop(.56, 'rgba(2,10,20,.20)'); night.addColorStop(.68, 'rgba(0,0,0,0)');
      X.save(); X.beginPath(); X.arc(screen.x, screen.y, radius, 0, Math.PI * 2); X.clip(); X.fillStyle = night; X.fillRect(screen.x - radius, screen.y - radius, radius * 2, radius * 2); X.restore();
    }
    if (radius > 12 || sel?.id === body.id) { X.fillStyle = '#e8f8ff'; X.font = '10px sans-serif'; X.fillText(body.name, screen.x + radius + 5, screen.y - 4); }
  }
  function marker(world, label, colour) { const p = ws(world); X.fillStyle = colour; X.beginPath(); X.arc(p.x, p.y, 4, 0, Math.PI * 2); X.fill(); X.fillStyle = '#e7f9ff'; X.font = '9px sans-serif'; X.fillText(label, p.x + 7, p.y - 7); }
  function drawHyperbolicArc(id, r, v, R, mu, h, e, p, ex, physical) {
    // Analytic hyperbola branch in the PLANET frame: craft -> SOI exit (or
    // screen edge for the sun). Exact 2-body math, stable at every warp.
    const origin = S[id];
    const dir = h >= 0 ? 1 : -1, perp = { x: -ex.y, y: ex.x };
    const nu = Math.atan2(r.x * perp.x + r.y * perp.y, r.x * ex.x + r.y * ex.y);
    const soi = (id && id !== 'sun' && window.ExolineNav) ? ExolineNav.soiRadius(id) : null;
    const span = Math.hypot(innerWidth, innerHeight) * 1.25 / cam.k;
    const exitR = (soi && finite(soi) && soi > R) ? soi : R + span;
    const cosExit = (p / exitR - 1) / Math.max(e, 1e-9);
    const fwd = (a, b) => { let d = dir > 0 ? b - a : a - b; while (d < 0) d += Math.PI * 2; return d; };
    let travel = Infinity, ok = Math.abs(cosExit) <= 1;
    if (ok) {
      for (const c of [Math.acos(Math.max(-1, Math.min(1, cosExit))), -Math.acos(Math.max(-1, Math.min(1, cosExit)))]) {
        const d = fwd(nu, c);
        if (d > 1e-6 && d < travel) travel = d;
      }
      if (!finite(travel)) ok = false;
    }
    X.save(); X.setLineDash([7, 6]); X.strokeStyle = 'rgba(255,192,115,.92)'; X.lineWidth = 1.5; X.beginPath();
    if (ok) {
      const NH = smoothCount(travel * (R + exitR) / 2, 48, 512);
      for (let i = 0; i <= NH; i++) {
        const th = nu + dir * travel * i / NH, rad = p / (1 + e * Math.cos(th));
        const pt = ws({ x: origin.x + rad * (Math.cos(th) * ex.x + Math.sin(th) * perp.x), y: origin.y + rad * (Math.cos(th) * ex.y + Math.sin(th) * perp.y) });
        i ? X.lineTo(pt.x, pt.y) : X.moveTo(pt.x, pt.y);
      }
    } else {
      // Degenerate (near-parabolic): straight asymptote ray, planet-relative.
      const speed = Math.hypot(v.x, v.y) || 1;
      const a = ws(F.s.r), b = ws({ x: F.s.r.x + v.x / speed * span, y: F.s.r.y + v.y / speed * span });
      X.moveTo(a.x, a.y); X.lineTo(b.x, b.y);
    }
    X.stroke(); X.setLineDash([]); X.restore();
    const peri = p / (1 + e);
    marker({ x: origin.x + peri * ex.x, y: origin.y + peri * ex.y }, `PE ${altitude(peri - physical.radius_m)}`, '#77edff');
    if (ok && soi && finite(soi) && soi > R) {
      const th = nu + dir * travel;
      marker({ x: origin.x + exitR * (Math.cos(th) * ex.x + Math.sin(th) * perp.x), y: origin.y + exitR * (Math.cos(th) * ex.y + Math.sin(th) * perp.y) }, 'SOI EXIT', '#ffcf9c');
    } else if (ok) {
      const th = nu + dir * travel;
      const end = ws({ x: origin.x + exitR * (Math.cos(th) * ex.x + Math.sin(th) * perp.x), y: origin.y + exitR * (Math.cos(th) * ex.y + Math.sin(th) * perp.y) });
      X.fillStyle = '#ffcf9c'; X.font = '9px sans-serif'; X.fillText('ESCAPE', end.x - 42, end.y - 8);
    }
  }
  // Render the numerical coast prediction when a simple conic would be
  // misleading: atmospheric flight, surface impact, or SOI escape.  This is
  // generated by navigation-engine with the same RK4 + drag model as flight.
  function drawNumericalCoast(leg, refId) {
    const records = leg?.records;
    if (!records || records.length < 2) return false;
    const physical = P.bodies[refId], origin = S[refId];
    if (!physical || !origin) return false;
    // Planet frame: frozen inertial records + live body position. rec.t is
    // seconds-since-build, so the body offset is sampled at each record's own
    // absolute time — no helical smear while the camera follows the planet.
    const worldAt = window.ExolineNav?._internals?.worldAt;
    const dtBuild = ((leg.builtAt || +date) - +date) / 1000;
    const rel = (pt, tSec) => {
      if (!worldAt || refId === 'sun') return { x: pt.x - origin.x, y: pt.y - origin.y };
      const bp = worldAt(refId, tSec);
      if (!bp) return null;
      return { x: pt.x - bp.x, y: pt.y - bp.y };
    };
    const stride = Math.max(1, Math.ceil(records.length / 250));
    const pts = [];
    for (let i = 0; i < records.length; i += stride) {
      const q = rel(records[i].r, records[i].t + dtBuild);
      if (q) pts.push(q);
    }
    const last = records[records.length - 1];
    const lastQ = rel(last.r, last.t + dtBuild);
    if (lastQ) pts.push(lastQ);
    if (pts.length < 2) return false;
    X.save(); X.strokeStyle = leg.impact ? '#ff7373' : '#ffc96d'; X.lineWidth = 1.8; X.setLineDash([5, 5]); X.beginPath();
    pts.forEach((q, i) => {
      const p = ws({ x: origin.x + q.x, y: origin.y + q.y });
      i ? X.lineTo(p.x, p.y) : X.moveTo(p.x, p.y);
      // The propagated path sits above body picking and is always a valid
      // place to offer a maneuver node, including an escape trajectory.
      orbitHitRegions.push({ x: p.x, y: p.y, t: Math.max(1, records[Math.min(records.length - 1, i * stride)].t) });
    });
    X.stroke(); X.setLineDash([]); X.restore();
    if (leg.impact) {
      const lq = pts[pts.length - 1], scale = physical.radius_m / Math.max(1, Math.hypot(lq.x, lq.y));
      marker({ x: origin.x + lq.x * scale, y: origin.y + lq.y * scale }, 'IMPACT', '#ff7373');
    } else {
      const lq = pts[pts.length - 1], end = ws({ x: origin.x + lq.x, y: origin.y + lq.y });
      X.fillStyle = '#ffcf9c'; X.font = '9px sans-serif'; X.fillText('ESCAPE', end.x + 7, end.y - 7);
    }
    return true;
  }
  function trajectory() {
    if (!craftSelected || !F || !S.sun) return;
    const d = F.diagnostics(S, sel?.id), id = currentSoi?.id || d.body;
    if (!id || !S[id]) return;
    const physical = P.bodies[id];
    const r = { x: F.s.r.x - S[id].x, y: F.s.r.y - S[id].y };
    const v = { x: F.s.v.x - S[id].vx, y: F.s.v.y - S[id].vy };
    const R = Math.hypot(r.x, r.y), mu = P.G * physical.mass, h = r.x * v.y - r.y * v.x;
    const ev = { x: (((v.x * v.x + v.y * v.y) - mu / R) * r.x - (r.x * v.x + r.y * v.y) * v.x) / mu, y: (((v.x * v.x + v.y * v.y) - mu / R) * r.y - (r.x * v.x + r.y * v.y) * v.y) / mu };
    const e = Math.hypot(ev.x, ev.y), p = h * h / mu;
    if (!finite(e) || !finite(p)) return;
    const ex = e > .00001 ? { x: ev.x / e, y: ev.y / e } : { x: r.x / R, y: r.y / R };
    const peri = p / (1 + e), apo = p / (1 - e);
    // On-rails coast: orbit elements come from the frozen arc, bit-identical
    // every frame, so AP/PE/ecc and every branch below can never flicker.
    const frozen = F.coast && F.coast.body === id ? F.coast : null;
    let eF = e, pF = p, exF = ex, periF = peri, apoF = apo;
    if (frozen) {
      const pl = Math.hypot(frozen.Px, frozen.Py);
      if (pl > 1e-9) {
        eF = frozen.e; pF = frozen.a * (1 - frozen.e * frozen.e);
        exF = { x: frozen.Px / pl, y: frozen.Py / pl };
        periF = frozen.a * (1 - frozen.e);
        apoF = frozen.e < 1 ? frozen.a * (1 + frozen.e) : Infinity;
      }
    }
    const atmosphere = ExolineFlight.atmospheres?.[id];
    const inAtmosphere = atmosphere && R - physical.radius_m < atmosphere.top;
    const numerical = navSnap?.heavy?.base;
    // Do not substitute a vacuum ellipse/straight line for a drag or escape
    // prediction.  The sampled curve also remains selectable for ADD NODE.
    // Skipped on-rails: a clean coast arc can never impact or drag by construction.
    if (!frozen && numerical && (numerical.impact || eF >= 1 || inAtmosphere)) {
      if (drawNumericalCoast(numerical, id)) {
        marker({ x: F.s.r.x, y: F.s.r.y }, 'CURRENT', '#ffbd76');
        return;
      }
    }
    if (periF <= physical.radius_m) {
      // An osculating orbit that intersects the body is an impact trajectory,
      // not a complete orbit. Draw only the forward arc to the surface.
      const perp = { x: -exF.y, y: exF.x };
      const nu = Math.atan2(r.x * perp.x + r.y * perp.y, r.x * exF.x + r.y * exF.y);
      const hitCos = Math.max(-1, Math.min(1, (pF / physical.radius_m - 1) / Math.max(eF, 1e-8)));
      const candidates = [Math.acos(hitCos), -Math.acos(hitCos)];
      const direction = h >= 0 ? 1 : -1;
      let hitNu = candidates[0], travel = Infinity;
      for (const candidate of candidates) {
        let delta = direction > 0 ? candidate - nu : nu - candidate;
        while (delta < 0) delta += Math.PI * 2;
        if (delta < travel) { travel = delta; hitNu = candidate; }
      }
      X.save(); X.strokeStyle = '#ff7373'; X.lineWidth = 1.8; X.setLineDash([5, 5]); X.beginPath();
      const NI = smoothCount(travel * (R + physical.radius_m) / 2, 48, 512);
      for (let i = 0; i <= NI; i++) {
        const theta = nu + direction * travel * i / NI, radial = pF / (1 + eF * Math.cos(theta));
        const point = ws({ x: S[id].x + radial * (Math.cos(theta) * exF.x + Math.sin(theta) * perp.x), y: S[id].y + radial * (Math.cos(theta) * exF.y + Math.sin(theta) * perp.y) });
        i ? X.lineTo(point.x, point.y) : X.moveTo(point.x, point.y);
      }
      X.stroke(); X.setLineDash([]); X.restore();
      const impact = { x: S[id].x + physical.radius_m * (Math.cos(hitNu) * exF.x + Math.sin(hitNu) * perp.x), y: S[id].y + physical.radius_m * (Math.cos(hitNu) * exF.y + Math.sin(hitNu) * perp.y) };
      marker({ x: F.s.r.x, y: F.s.r.y }, 'CURRENT', '#ffbd76');
      marker(impact, 'IMPACT', '#ff7373');
      return;
    }
    if (eF >= 1) { drawHyperbolicArc(id, r, v, R, mu, h, eF, pF, exF, physical); marker({ x: F.s.r.x, y: F.s.r.y }, 'CURRENT', '#ffbd76'); return; }
    // Closed conic: draw the full predicted orbit around the SOI body, in the
    // body's local frame, so the trajectory reads as an orbit around the planet
    // the craft is entering -- not as a wavy line in the solar-system frame.
    // The ellipse is rendered in screen space via ws() so it stays visible at
    // any zoom; the perigee/apogee markers sit on the same ellipse centre.
    // Shape comes from the frozen coast arc when on-rails: pixel-identical.
    const a = pF / (1 - eF * eF), b = a * Math.sqrt(Math.max(0, 1 - eF * eF)), cc = a * eF, perp = { x: -exF.y, y: exF.x };
    const N = smoothCount(ellipsePerimeter(a, b), 96, 2048), hitStride = Math.max(1, Math.floor(N / 256));
    const origin = { x: S[id].x, y: S[id].y };
    const cx = { x: origin.x - cc * exF.x, y: origin.y - cc * exF.y };
    X.save();
    X.beginPath();
    const period = 2 * Math.PI * Math.sqrt(a ** 3 / mu), currentNu = Math.atan2(r.x * perp.x + r.y * perp.y, r.x * exF.x + r.y * exF.y), direction = h >= 0 ? 1 : -1;
    for (let i = 0; i <= N; i++) {
      const th = (2 * Math.PI * i) / N;
      const px = cx.x + a * Math.cos(th) * exF.x + b * Math.sin(th) * perp.x;
      const py = cx.y + a * Math.cos(th) * exF.y + b * Math.sin(th) * perp.y;
      const screen = ws({ x: px, y: py });
      if (i % hitStride === 0) {
        let phase = direction > 0 ? th - currentNu : currentNu - th; while (phase < 0) phase += Math.PI * 2;
        orbitHitRegions.push({ x: screen.x, y: screen.y, t: Math.max(30, phase / (Math.PI * 2) * period) });
      }
      i ? X.lineTo(screen.x, screen.y) : X.moveTo(screen.x, screen.y);
    }
    X.closePath();
    X.strokeStyle = '#78e5ff';
    X.lineWidth = 1.6;
    X.stroke();
    X.restore();
    // The apses are measured from the ellipse centre by its semi-major axis;
    // peri/apo are distances from the focus, so using them here misplaces both.
    const periPoint = { x: cx.x + a * exF.x, y: cx.y + a * exF.y };
    const apoPoint = { x: cx.x - a * exF.x, y: cx.y - a * exF.y };
    marker(periPoint, `PE ${altitude(periF - physical.radius_m)}`, '#77edff');
    marker(apoPoint, `AP ${altitude(apoF - physical.radius_m)}`, '#ffbd76');
  }
  function craft() { if (!F) return; const p = ws(F.s.r); X.save(); X.translate(p.x, p.y); X.rotate(-F.s.heading + Math.PI / 2); X.fillStyle = '#f8fdff'; X.strokeStyle = '#0b3040'; X.lineWidth = 2; X.beginPath(); X.moveTo(0, -15); X.lineTo(11, 11); X.lineTo(-11, 11); X.closePath(); X.fill(); X.stroke(); X.fillStyle = '#53ddff'; X.beginPath(); X.moveTo(0, -8); X.lineTo(3, 3); X.lineTo(-3, 3); X.closePath(); X.fill(); X.restore(); }
  function hud() { $('flightHud').classList.toggle('hidden', !craftSelected); if (!craftSelected || !F) return; const d = F.diagnostics(S, sel?.id), name = D.bodies.find(b => b.id === d.body)?.name || 'Sun', radius = P.bodies[d.body]?.radius_m || 0; const fr = F.coast && F.coast.body === d.body ? F.coast : null, ecc = fr ? fr.e : d.e, apo = fr ? (fr.e < 1 ? fr.a * (1 + fr.e) : Infinity) : d.apo, peri = fr ? fr.a * (1 - fr.e) : d.peri; $('hudSoi').textContent = name.toUpperCase(); $('hudAlt').textContent = d.alt < 10000 ? `${Math.round(d.alt)} m` : `${(d.alt / 1000).toFixed(1)} km`; $('hudVel').textContent = d.speed < 1000 ? `${d.speed.toFixed(1)} m/s` : `${Math.round(d.speed).toLocaleString('en-US')} m/s`; $('hudApo').textContent = altitude(apo - radius); $('hudPeri').textContent = altitude(peri - radius); $('hudEcc').textContent = ecc.toFixed(4); $('hudDistance').textContent = altitude(d.target); $('launchBtn').textContent = F.s.throttle > 0 ? 'CUTOFF' : 'IGNITION'; }
  function vehicleReadout() { if (!F) return; $('shipMass').textContent = `${(F.s.m / 1000).toFixed(2)} t`; $('shipThrust').textContent = `${(F.thrust / 1000).toFixed(0)} kN`; $('shipTwr').textContent = (F.thrust * Math.max(F.s.throttle, .01) / (F.s.m * 9.80665)).toFixed(2); }
  // ---------- navigation rendering (world -> screen via the same ws() transform) ----------
  function drawLegPath(records, offset, colour, width, dashed) {
    if (!records || records.length < 2) return;
    const stride = Math.max(1, Math.ceil(records.length / 1800));
    X.save(); X.strokeStyle = colour; X.lineWidth = width; if (dashed) X.setLineDash([6, 5]);
    X.beginPath();
    let started = false;
    for (let i = 0; i < records.length; i += stride) {
      const rec = records[i], p = ws({ x: rec.r.x + offset.x, y: rec.r.y + offset.y });
      started ? X.lineTo(p.x, p.y) : X.moveTo(p.x, p.y); started = true;
    }
    const last = records[records.length - 1], lp = ws({ x: last.r.x + offset.x, y: last.r.y + offset.y });
    X.lineTo(lp.x, lp.y); X.stroke(); X.restore();
  }
  function localOrbitFromState(state, refId, origin = S[refId]) {
    const physical = P?.bodies?.[refId]; if (!physical || !origin || !state) return null;
    const r = { x: state.r.x - origin.x, y: state.r.y - origin.y }, v = { x: state.v.x - (origin.vx || 0), y: state.v.y - (origin.vy || 0) };
    const R = Math.hypot(r.x, r.y), mu = P.G * physical.mass; if (!(R > 0 && mu > 0)) return null;
    const h = r.x * v.y - r.y * v.x, p = h * h / mu;
    const ev = { x: (((v.x * v.x + v.y * v.y) - mu / R) * r.x - (r.x * v.x + r.y * v.y) * v.x) / mu, y: (((v.x * v.x + v.y * v.y) - mu / R) * r.y - (r.x * v.x + r.y * v.y) * v.y) / mu };
    const e = Math.hypot(ev.x, ev.y), a = p / Math.max(1e-12, 1 - e * e); if (!(e < 1 && a > 0)) return null;
    const ex = e > 1e-6 ? { x: ev.x / e, y: ev.y / e } : { x: r.x / R, y: r.y / R }, perp = { x: -ex.y, y: ex.x };
    return { a, e, ex, perp, period: 2 * Math.PI * Math.sqrt(a ** 3 / mu) };
  }
  function drawPlanetPlan(relRecords, origin, colour, dashed) {
    // Planet-frame planned path: frozen body-relative offsets + LIVE body
    // position. No per-frame math on the live craft state, so zero jitter.
    if (!relRecords || relRecords.length < 2 || !origin) return;
    X.save(); X.strokeStyle = colour; X.lineWidth = 1.8; if (dashed) X.setLineDash([5, 5]); X.beginPath();
    for (let i = 0; i < relRecords.length; i++) {
      const q = relRecords[i], p = ws({ x: origin.x + q.x, y: origin.y + q.y });
      i ? X.lineTo(p.x, p.y) : X.moveTo(p.x, p.y);
    }
    X.stroke(); X.restore();
  }
  function localNodePosition(seconds, refId) {
    const orbit = localOrbitFromState(F.s, refId), origin = S[refId]; if (!orbit || !origin) return null;
    const r = { x: F.s.r.x - origin.x, y: F.s.r.y - origin.y };
    const nu = Math.atan2(r.x * orbit.perp.x + r.y * orbit.perp.y, r.x * orbit.ex.x + r.y * orbit.ex.y);
    const e0 = 2 * Math.atan2(Math.sqrt(1 - orbit.e) * Math.sin(nu / 2), Math.sqrt(1 + orbit.e) * Math.cos(nu / 2));
    const mean = e0 - orbit.e * Math.sin(e0) + (Math.PI * 2 / orbit.period) * seconds;
    let eccentric = mean;
    for (let i = 0; i < 8; i++) eccentric -= (eccentric - orbit.e * Math.sin(eccentric) - mean) / (1 - orbit.e * Math.cos(eccentric));
    const radial = orbit.a * (1 - orbit.e * Math.cos(eccentric));
    const trueAnomaly = Math.atan2(Math.sqrt(1 - orbit.e * orbit.e) * Math.sin(eccentric), Math.cos(eccentric) - orbit.e);
    return { x: origin.x + radial * (Math.cos(trueAnomaly) * orbit.ex.x + Math.sin(trueAnomaly) * orbit.perp.x), y: origin.y + radial * (Math.cos(trueAnomaly) * orbit.ex.y + Math.sin(trueAnomaly) * orbit.perp.y) };
  }
  function maneuverMarker(mark, offset, localPosition = null) {
    const p = localPosition ? ws(localPosition) : ws({ x: mark.point.x + offset.x, y: mark.point.y + offset.y });
    const selected = mark.node.id === activeNodeId;
    nodeHitRegions.push({ id: mark.node.id, x: p.x, y: p.y, radius: 14 });
    X.save(); X.strokeStyle = selected ? '#fff1f1' : '#ff7373'; X.fillStyle = selected ? '#ff4d4d' : '#c82735'; X.lineWidth = selected ? 2.2 : 1.4;
    X.beginPath(); X.arc(p.x, p.y, selected ? 7 : 5, 0, Math.PI * 2); X.fill(); X.stroke();
    if (selected) { X.strokeStyle = 'rgba(255,115,115,.55)'; X.beginPath(); X.arc(p.x, p.y, 11, 0, Math.PI * 2); X.stroke(); }
    X.fillStyle = '#ffd6d6'; X.font = '9px sans-serif';
    X.fillText(`NODE · T+ ${ExolineNav.fmtDur(mark.node.t)} · ${ExolineNav.fmtDv(mark.node.totalDv)}`, p.x + 10, p.y - 9);
    X.restore();
  }
  function approachMarker(approach, offset) {
    const from = ws(F.s.r), p = ws({ x: approach.point.x + offset.x, y: approach.point.y + offset.y });
    X.save(); X.strokeStyle = 'rgba(255,115,115,.8)'; X.lineWidth = 1.2;
    X.setLineDash([3, 4]); X.beginPath(); X.moveTo(from.x, from.y); X.lineTo(p.x, p.y); X.stroke(); X.setLineDash([]);
    X.beginPath(); X.moveTo(p.x - 4, p.y - 4); X.lineTo(p.x + 4, p.y + 4); X.moveTo(p.x + 4, p.y - 4); X.lineTo(p.x - 4, p.y + 4); X.stroke();
    X.fillStyle = '#ffb3b3'; X.font = '9px sans-serif';
    X.fillText(`MISS ${ExolineNav.fmtDistance(approach.distance)}`, p.x + 7, p.y + 13);
    X.restore();
  }
  function drawFrozenPlannedOrbit(local, liveOrigin) {
    // Frozen post-burn orbit shape (solved once at node edit) drawn around the
    // body's LIVE position: follows the planet, never changes shape.
    if (!local || !liveOrigin) return;
    const b = Math.sqrt(Math.max(0, 1 - local.e * local.e));
    const NW = smoothCount(ellipsePerimeter(local.a, b), 120, 1024);
    const cx = liveOrigin.x - local.a * local.e * local.ex.x;
    const cy = liveOrigin.y - local.a * local.e * local.ex.y;
    X.save(); X.strokeStyle = 'rgba(255,255,255,.96)'; X.lineWidth = 1.5; X.setLineDash([3, 5]); X.beginPath();
    for (let i = 0; i <= NW; i++) {
      const theta = Math.PI * 2 * i / NW;
      const p = ws({ x: cx + local.a * Math.cos(theta) * local.ex.x + local.a * b * Math.sin(theta) * local.perp.x, y: cy + local.a * Math.cos(theta) * local.ex.y + local.a * b * Math.sin(theta) * local.perp.y });
      i ? X.lineTo(p.x, p.y) : X.moveTo(p.x, p.y);
    }
    X.stroke(); X.restore();
  }
  function navPaths() {
    if (!craftSelected || !F || !navSnap || !navSnap.heavy || !navSnap.heavy.base || !navSnap.heavy.base.startR) return;
    const heavy = navSnap.heavy;
    // The local trajectory renderer owns the unburned orbit.  Showing the
    // sampled blue transfer line here makes it read like a sine wave and hides
    // the actual maneuver result.  Only a planned post-burn path is drawn.
    if (!heavy.plan) return;
    // SOI-planet frame only: frozen offsets + live body position. There is no
    // sun-frame rendering anywhere in the flight view.
    const zero = { x: 0, y: 0 };
    const plan = heavy.plan, refId = plan.refId || plan.local?.refId, origin = refId ? S[refId] : null;
    const predictedOrbit = plan.segments[plan.segments.length - 1];
    const isSunPlan = !refId || refId === 'sun';
    if (isSunPlan) {
      if (predictedOrbit) drawLegPath(predictedOrbit.records, zero, '#78e5ff', 1.8, true);
    } else if (origin && plan.relRecords) {
      if (plan.impact) {
        drawPlanetPlan(plan.relRecords, origin, '#ff7373', true);
        if (plan.relImpact) marker({ x: origin.x + plan.relImpact.x, y: origin.y + plan.relImpact.y }, 'IMPACT', '#ff7373');
      } else if (plan.local && plan.local.refId === refId) {
        drawFrozenPlannedOrbit(plan.local, origin);
      } else if (plan.relRecords && plan.relRecords.length >= 2) {
        // Escape / hyperbolic post-burn path wrt the planet.
        drawPlanetPlan(plan.relRecords, origin, '#ffc96d', true);
        const end = plan.relRecords[plan.relRecords.length - 1];
        X.fillStyle = '#ffcf9c'; X.font = '9px sans-serif';
        const label = ws({ x: origin.x + end.x, y: origin.y + end.y });
        X.fillText('ESCAPE', label.x + 7, label.y - 7);
      }
      if (plan.relApproach && !plan.impact) approachMarker({ point: { x: origin.x + plan.relApproach.x, y: origin.y + plan.relApproach.y }, distance: plan.approach ? plan.approach.distance : 0 }, zero);
      else if (plan.approach && plan.approach.point && !plan.approach.atHorizon) approachMarker(plan.approach, zero);
    }
    const liveTimes = new Map((navSnap.nodes || []).map(n => [n.id, n.t]));
    for (const mark of heavy.plan.marks) {
      // Burn point in the PLANET frame (live body position + frozen offset) so
      // the marker sits exactly on the blue orbit. Label countdown stays live
      // via the snapshot (plan itself is not rebuilt).
      if (liveTimes.has(mark.node.id)) mark.node.t = liveTimes.get(mark.node.id);
      const markOrigin = (mark.refId && S[mark.refId]) || (plan.refId && S[plan.refId]) || null;
      const markPos = (mark.rel && markOrigin) ? { x: markOrigin.x + mark.rel.x, y: markOrigin.y + mark.rel.y } : (mark.point || null);
      maneuverMarker(mark, zero, markPos);
    }
  }
  function drawTargetMarker() {
    if (!navSnap || !navSnap.targetId) return;
    const state = S[navSnap.targetId]; if (!state) return;
    const p = ws(state); // canonical COM: same world->screen transform as sprite, orbit, selection
    const catalog = D.bodies.find(b => b.id === navSnap.targetId);
    const screenR = catalog ? radiusOf(catalog) : 4;
    const R = Math.max(13, screenR > 10 ? screenR * 1.35 + 7 : 13);
    if (navSnap.targetSoiRadius) {
      const soiPx = navSnap.targetSoiRadius * cam.k;
      if (soiPx > 20 && soiPx < 9000) { X.save(); X.strokeStyle = 'rgba(109,184,255,.28)'; X.lineWidth = 1; X.setLineDash([5, 6]); X.beginPath(); X.arc(p.x, p.y, soiPx, 0, Math.PI * 2); X.stroke(); X.restore(); }
    }
    const arm = Math.min(7, R * .5);
    X.save(); X.strokeStyle = '#6db8ff'; X.lineWidth = 1.6;
    for (const corner of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const sx = corner[0], sy = corner[1], cx = p.x + sx * R, cy = p.y + sy * R;
      X.beginPath(); X.moveTo(cx - sx * arm, cy); X.lineTo(cx, cy); X.lineTo(cx, cy - sy * arm); X.stroke();
    }
    X.fillStyle = '#eaf7ff'; X.font = '8px sans-serif';
    X.fillText(`TARGET · ${navSnap.targetName.toUpperCase()}`, p.x - R, p.y + R + 11);
    X.restore();
  }
  function navArrow(origin, dir, colour, kind) {
    const planar = Math.hypot(dir.x, dir.y);
    if (planar < .18) return; // direction mostly out of plane: no misleading 2D arrow (PART 11)
    const dx = dir.x * cam.k, dy = -dir.y * cam.k, mag = Math.hypot(dx, dy);
    if (!(mag > 0)) return;
    const ux = dx / mag, uy = dy / mag, px = -uy, py = ux;
    const x0 = origin.x + ux * 11, y0 = origin.y + uy * 11, x1 = origin.x + ux * 30, y1 = origin.y + uy * 30;
    X.save(); X.globalAlpha = Math.min(1, planar * 1.5); X.strokeStyle = colour; X.fillStyle = colour; X.lineWidth = 1.3;
    if (kind === 'retro') X.setLineDash([3, 3]);
    X.beginPath(); X.moveTo(x0, y0); X.lineTo(x1, y1); X.stroke(); X.setLineDash([]);
    if (kind === 'pro') { X.beginPath(); X.moveTo(x1 + ux * 6, y1 + uy * 6); X.lineTo(x1 + px * 4, y1 + py * 4); X.lineTo(x1 - px * 4, y1 - py * 4); X.closePath(); X.stroke(); }
    else if (kind === 'retro') { X.beginPath(); X.arc(x1, y1, 4, 0, Math.PI * 2); X.stroke(); X.beginPath(); X.moveTo(x1 - px * 4, y1 - py * 4); X.lineTo(x1 + px * 4, y1 + py * 4); X.stroke(); }
    else { X.beginPath(); X.moveTo(x1 - ux * 5 + px * 4, y1 - uy * 5 + py * 4); X.lineTo(x1 + ux * 2, y1 + uy * 2); X.lineTo(x1 - ux * 5 - px * 4, y1 - uy * 5 - py * 4); X.stroke(); }
    X.restore();
  }
  function drawVectors() {
    if (!craftSelected || !F || !navSnap) return;
    const origin = ws(F.s.r);
    const frame = ExolineNav.getVelocityFrame(F.s, navSnap.refId, 0);
    if (frame) {
      navArrow(origin, frame.prograde, '#77edff', 'pro');
      navArrow(origin, { x: -frame.prograde.x, y: -frame.prograde.y, z: -frame.prograde.z }, '#ffbd76', 'retro');
      const planning = !$('navNode').classList.contains('hidden');
      if (planning) {
        navArrow(origin, frame.radial, 'rgba(234,247,255,.85)', 'radial');
        navArrow(origin, { x: -frame.radial.x, y: -frame.radial.y, z: -frame.radial.z }, 'rgba(234,247,255,.5)', 'radial');
      }
    }
  }
  // ---------- navigation panel (DOM updates, never math) ----------
  function navUi() {
    const snap = navSnap; if (!snap) return;
    const show = craftSelected || snap.targetId || snap.nodes.length;
    $('navPanel').classList.toggle('hidden', !show);
    if (!show) return;
    const els = snap.elements;
    setText('navSoi', snap.refName.toUpperCase());
    setText('navTarget', snap.targetName ? snap.targetName.toUpperCase() : '—');
    setText('navDist', snap.live ? ExolineNav.fmtDistance(snap.live.distance) : '—');
    setText('navRelVel', snap.live ? ExolineNav.fmtSpeed(snap.live.speedRel) : '—');
    setText('navApo', ExolineNav.fmtApo(els));
    setText('navPeri', ExolineNav.fmtPeri(els));
    setText('navEcc', els ? ExolineNav.fmtEcc(els.ecc) : '—');
    setText('navSpeed', els ? ExolineNav.fmtSpeed(els.speed) : '—');
    setText('navRadial', els ? ExolineNav.fmtSignedSpeed(els.radial) : '—');
    setText('navClosing', snap.live ? ExolineNav.fmtSignedSpeed(snap.live.closing) : '—');
    setText('navTca', snap.approach && !snap.approach.atHorizon ? ExolineNav.fmtDur(snap.approach.tSec) : '—');
    setText('navMiss', snap.approach ? ExolineNav.fmtDistance(snap.approach.distance) : '—');
    setText('navPeriod', els && els.period ? ExolineNav.fmtDur(els.period) : '—');
    setText('navVEsc', els ? ExolineNav.fmtSpeed(els.vEsc) : '—');
    setText('navEnergy', ExolineNav.fmtEnergy(els ? els.energy : null));
    setText('navInc', els ? ExolineNav.fmtDeg(els.inc) : '—');
    const transfer = snap.transfer;
    setText('navTransferTitle', transfer ? `${transfer.method} · APPROX` : '—');
    setText('navTransferDep', transfer ? ExolineNav.fmtDv(transfer.dvDeparture) : '—');
    setText('navTransferArr', transfer ? ExolineNav.fmtDv(transfer.dvArrival) : '—');
    setText('navTransferTime', transfer ? ExolineNav.fmtDur(transfer.timeSeconds) : '—');
    setText('navDvTotal', snap.nodes.length ? ExolineNav.fmtDv(snap.dvTotal) : '—');
    if (sel) setText('setTargetBtn', snap.targetId === sel.id ? 'TARGETED ✓' : 'SET TARGET');
    else setText('setTargetBtn', 'SET TARGET');
    syncNodeForm(snap);
    const burnBox = $('burnProgress');
    if (burnBox) {
      const showBurn = !!autoBurn && (autoBurn.phase === 'BURN' || autoBurn.phase === 'ALIGN');
      burnBox.classList.toggle('hidden', !showBurn);
      if (showBurn) {
        const bnode = snap.nodes.find(n => n.id === autoBurn.nodeId);
        const btotal = bnode ? bnode.totalDv : 0;
        const bdone = Math.min(autoBurn.delivered || 0, btotal);
        const pct = btotal > 0 ? Math.max(0, Math.min(100, bdone / btotal * 100)) : 0;
        const fill = $('burnProgressFill'), label = $('burnProgressText');
        if (fill) fill.style.width = pct.toFixed(1) + '%';
        if (label) {
          if (autoBurn.phase === 'BURN') {
            const accel = F ? F.thrust / Math.max(F.s.m, 1) : 0;
            const left = btotal > 0 ? Math.max(0, btotal - bdone) / Math.max(accel, 1e-9) : 0;
            label.textContent = `BURN ${pct.toFixed(0)}% · T−${ExolineNav.fmtDur(left)} LEFT`;
          } else {
            label.textContent = `ALIGNING · T−${ExolineNav.fmtDur(Math.max(0, (autoBurn.fireAt - +date) / 1000))}`;
          }
        }
      }
    }
  }
  function syncNodeForm(snap) {
    const node = snap.nodes.find(n => n.id === activeNodeId) || snap.nodes[0];
    if (!node) { activeNodeId = null; $('navNode').classList.add('hidden'); return; }
    activeNodeId = node.id;
    setText('navNodeTime', `T+ ${ExolineNav.fmtDur(node.t)}`);
    setText('navNodeTotal', ExolineNav.fmtDv(node.totalDv));
    const fields = [['navNodePro', 'progradeDv'], ['navNodeRad', 'radialDv'], ['navNodeNor', 'normalDv']];
    for (const field of fields) { const input = $(field[0]); if (document.activeElement !== input && String(node[field[1]]) !== input.value) input.value = String(node[field[1]]); }
  }
  function addNodeForCraft(time = 600) {
    const node = ExolineNav.addNode({ t: Math.max(0, time), referenceBody: ExolineNav.currentRefId() });
    const refId = node.referenceBody, point = refId !== 'sun' ? localNodePosition(node.t, refId) : null;
    if (point && S[refId]) nodeAnchors.set(node.id, { refId, rel: { x: point.x - S[refId].x, y: point.y - S[refId].y } });
    activeNodeId = node.id;
    $('navNode').classList.remove('hidden');
    $('navPanel').classList.remove('hidden');
    $('navPanel').classList.remove('collapsed');
    showToast(`MANEUVER NODE ADDED · T+ ${ExolineNav.fmtDur(Math.max(0, time))}`);
  }
  function stepNodeTime(direction) {
    const nodes = ExolineNav.getNodes(), node = nodes.find(n => n.id === activeNodeId) || nodes[0];
    if (!node) return;
    // Epoch-based: derive live remaining from the absolute burn epoch (drift-free).
    const remaining = Math.max(0, ((node.epoch || (+date + (node.t || 0) * 1000)) - +date) / 1000);
    const step = remaining >= 86400 ? 3600 : remaining >= 3600 ? 300 : 60;
    ExolineNav.updateNode(node.id, { t: Math.max(0, remaining + direction * step) });
    ExolineNav.setEditing(true);
    setTimeout(() => ExolineNav.setEditing(false), 500);
  }
  const angleDelta = (from, to) => Math.atan2(Math.sin(to - from), Math.cos(to - from));
function startAutoBurn() {
    const node = ExolineNav.getNodes().find(n => n.id === activeNodeId) || ExolineNav.getNodes()[0];
    if (!node) { showToast('AUTO BURN · NO NODE'); return; }
    if (Math.abs(node.normalDv) > .01) { showToast('AUTO BURN · NORMAL Δv NEEDS 3D RCS'); return; }
    if (node.totalDv <= .01) { showToast('AUTO BURN · SET A Δv FIRST'); return; }
    const needed = F.propellantForDeltaV(node.totalDv);
    if (!F.infiniteFuel && needed > F.s.propellant + 1e-6) { showToast(`AUTO BURN · NEEDS ${Math.ceil(needed)} kg FUEL`); return; }
    // Center the finite burn on the node epoch (KSP style): start half a burn early
    // so the impulsive prediction stays accurate.
    const mdot = F.thrust / (F.specificImpulse * 9.80665);
    const burnTime = mdot > 0 ? needed / mdot : 0;
    const epoch = node.epoch || (+date + node.t * 1000);
    autoBurn = { nodeId: node.id, nodeTime: node.t, fireAt: epoch - burnTime * 500, delivered: 0, phase: 'COAST', initialMass: 0, estBurn: burnTime, burnSimStart: 0, appliedRate: 0 };
    $('throttle').disabled = true; $('launchBtn').disabled = true;
    setWarp(1);
    $('navExecute').textContent = 'CANCEL AUTO';
    showToast(`AUTO BURN ARMED · T+ ${ExolineNav.fmtDur(node.t)}`);
  }
  function cancelAutoBurn(message = 'AUTO BURN CANCELLED') {
    autoBurn = null; setThrottle(0, true); $('throttle').disabled = false; $('launchBtn').disabled = false; $('navExecute').textContent = 'AUTO BURN'; showToast(message);
  }
  function updateAutoBurn(physicsSeconds) {
    if (!autoBurn) return;
    const node = ExolineNav.getNodes().find(n => n.id === autoBurn.nodeId);
    if (!node || F.s.crashed || (!F.infiniteFuel && F.s.propellant <= 0)) { cancelAutoBurn('AUTO BURN ABORTED'); return; }
    if (autoBurn.phase === 'COAST' && +date >= autoBurn.fireAt - 15000) { autoBurn.phase = 'ALIGN'; }
    if (autoBurn.phase !== 'ALIGN' && autoBurn.phase !== 'BURN') return;
    if (warpIndex !== 0) setWarp(0); // burns always execute at 1x: warp + burns never mix
    // Steer along the FROZEN inertial burn vector solved at node edit time:
    // zero per-frame propagation, zero jitter.
    const burn = ExolineNav.calculateBurn(node);
    if (!burn || burn.total <= 0) { cancelAutoBurn('AUTO BURN · BAD Δv'); return; }
    const frozen = node.dv_vec && (node.dv_vec.x || node.dv_vec.y) ? node.dv_vec : null;
    let dv;
    if (frozen) {
      dv = { x: frozen.x, y: frozen.y };
    } else {
      const exec = ExolineNav.prepareExecution();
      if (!exec.ok || !exec.frame) { cancelAutoBurn('AUTO BURN · ' + exec.reason); return; }
      const frame = exec.frame;
      dv = { x: frame.prograde.x * burn.prograde + frame.radial.x * burn.radial, y: frame.prograde.y * burn.prograde + frame.radial.y * burn.radial };
    }
    if (Math.hypot(dv.x, dv.y) < 1e-9) { cancelAutoBurn('AUTO BURN · BAD Δv'); return; }
    // PD pitch: proportional rate with a hard cap — slews fast, settles clean.
    const targetHeading = Math.atan2(dv.y, dv.x);
    const error = angleDelta(F.s.heading, targetHeading);
    const maxRate = 2.5 * Math.max(0, physicsSeconds);
    F.s.heading += Math.abs(error) < 1e-9 ? 0 : Math.sign(error) * Math.min(Math.abs(error) * 4, maxRate);
    // Watchdog: sim-time cap so a burn can never run forever.
    if (autoBurn.phase === 'BURN') {
      if (!autoBurn.burnSimStart) autoBurn.burnSimStart = +date;
      if ((+date - autoBurn.burnSimStart) / 1000 > (autoBurn.estBurn || 60) * 3 + 120) { cancelAutoBurn('AUTO BURN TIMEOUT'); return; }
    }
    if (Math.abs(error) > .035 || +date < autoBurn.fireAt) { autoBurn.appliedRate = 0; setThrottle(0, true); return; }
    autoBurn.phase = 'BURN';
    if (!autoBurn.burnSimStart) autoBurn.burnSimStart = +date;
    // Throttle control: full thrust when far, ease off to land exactly on Δv.
    // In BURN with a big pointing error, hold thrust until re-aligned.
    const remaining = Math.max(0, node.totalDv - (autoBurn.delivered || 0));
    const accel = F.thrust / Math.max(F.s.m, 1);
    let thr;
    if (Math.abs(error) > .12) thr = 0;
    else if (remaining > accel * 1.0) thr = 100;
    else thr = Math.max(8, Math.min(100, remaining / Math.max(accel * 0.5, 1e-9) * 100));
    autoBurn.appliedRate = F.thrust * (thr / 100) / Math.max(F.s.m, 1);
    setThrottle(thr, true);
  }
  function finishAutoBurn(physicsSeconds) {
    if (!autoBurn || autoBurn.phase !== 'BURN') return;
    const node = ExolineNav.getNodes().find(n => n.id === autoBurn.nodeId);
    if (!node) return;
    // Delivered Δv = integrated thrust acceleration. Exact in every fuel mode
    // (infinite fuel never changes mass, so mass-ratio tracking can't work).
    const rate = autoBurn.appliedRate || 0;
    if (rate > 0 && physicsSeconds > 0) autoBurn.delivered = (autoBurn.delivered || 0) + rate * physicsSeconds;
    autoBurn.appliedRate = 0;
    const tol = Math.max(0.05, rate * physicsSeconds * 0.5);
    if (autoBurn.delivered + tol < node.totalDv) return;
    const id = autoBurn.nodeId;
    setThrottle(0, true); nodeAnchors.delete(id); ExolineNav.commitExecution(id); ExolineNav.invalidate();
    autoBurn = null; $('throttle').disabled = false; $('launchBtn').disabled = false; $('navExecute').textContent = 'AUTO BURN';
    if (!ExolineNav.getNodes().length) $('navNode').classList.add('hidden');
    showToast(`AUTO BURN COMPLETE · Δv ${ExolineNav.fmtDv(node.totalDv)}`);
  }
  function updateWarp() { const button = $('warpBtn'); button.innerHTML = `${running ? pauseIcon : playIcon}<span>${running ? warpText(WARP[warpIndex]) : ''}</span>`; button.classList.toggle('is-paused', !running); button.setAttribute('aria-label', running ? `Pause at ${warpText(WARP[warpIndex])}` : 'Resume simulation'); }
  function setWarp(index) { warpIndex = Math.max(0, Math.min(WARP.length - 1, index)); simulationBacklog = 0; updateWarp(); }
  function follow() {
    // Dragging or a held manual pan always wins over auto-follow.
    if (panning || panned) return;
    if (craftSelected && F) {
      cam.o.x = F.s.r.x;
      cam.o.y = F.s.r.y;
    } else if (currentSoi) {
      cam.o.x = S[currentSoi.id].x;
      cam.o.y = S[currentSoi.id].y;
    }
  }
  function focusCraftView() {
    if (!F) return;
    cam.o = { x: F.s.r.x, y: F.s.r.y };
    cam.k = zoomCraft();
  }
  function zoomCraft() {
    if (!F) return 0;
    const diag = F.diagnostics(S, sel?.id);
    const bodyId = diag.body;
    const physical = P?.bodies?.[bodyId];
    if (!physical || !finite(diag.a) || diag.a <= 0) return 70 / 6.4e6;
    // Fit the craft's current conic (semi-major axis / apoapsis) to a readable
    // screen size so the orbit ring is always visible and the body is never a
    // microscopic dot.
    const target = finite(diag.apo) && diag.apo > diag.a ? diag.apo : diag.a;
    return 340 / target;
  }
  function resetView() {
    cam.k = innerHeight / (2.5 * AU);
    cam.o.x = 0;
    cam.o.y = 0;
  }
  function draw() {
    const soi = soiBody();
    if (soi) currentSoi = soi;
    else currentSoi = null;
    follow();
    // Continuous keyboard pan (held keys) -- independent of the mouse drag.
    const panSpeed = 5 / (cam.k || 1);
    if (keys.pan.up) cam.o.y -= panSpeed;
    if (keys.pan.down) cam.o.y += panSpeed;
    if (keys.pan.left) cam.o.x += panSpeed;
    if (keys.pan.right) cam.o.x -= panSpeed;
    try {
      navSnap = ExolineNav.tick();
    } catch (error) {
      // Navigation preview must never prevent the flight scene or mission menu
      // from opening. The next invalidation can rebuild it after bad input.
      console.error('Navigation preview unavailable:', error);
      navSnap = null;
    }
    nodeHitRegions = []; orbitHitRegions = [];
    X.fillStyle = '#02070c';
    X.fillRect(0, 0, innerWidth, innerHeight);
    for (let i = 0; i < 140; i++) { X.fillStyle = 'rgba(190,230,250,.25)'; X.fillRect((i * 197) % innerWidth, (i * 89) % innerHeight, 1, 1); }
    if (!D) return;
    D.bodies.forEach(b => orbit(b.id));
    body({ id: 'sun', name: 'Sun', orbital_asset: D.sun.asset }, S.sun);
    D.bodies.forEach(b => body(b, S[b.id]));
    trajectory();
    navPaths();
    drawTargetMarker();
    craft();
    drawVectors();
    hud();
    navUi();
    vehicleReadout();
    $('simDate').textContent = date.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
    updateWarp();
    if (window.ExolinePhysicsAgent && window.ExolinePhysicsAgent.drawDebugOverlay) {
      window.ExolinePhysicsAgent.drawDebugOverlay(X);
    }
  }
  function inspect(body) { sel = body; craftSelected = false; lock = 'body'; $('detailPanel').classList.remove('hidden'); $('detailName').textContent = body.name; $('detailKicker').textContent = 'CELESTIAL BODY'; $('detailSub').textContent = body.parent ? `MOON OF ${body.parent.toUpperCase()}` : 'SOL SYSTEM'; $('detailType').textContent = body.type; $('detailOrbit').textContent = body.kind === 'major_moon' ? 'LOCAL ORBIT' : 'HELIOCENTRIC'; $('detailPeriod').textContent = 'LIVE STATE'; $('detailSeed').textContent = body.seed || '—'; $('detailNote').textContent = 'Orbital position and rendered orbit use the same propagated Keplerian state.'; if (minerals) { const data = minerals[body.name]; const box = $('minerals'); if (!data) { box.textContent = 'No mineral profile defined for this body.'; return; } box.textContent = ''; for (const [name, frac] of Object.entries(data).sort((a, b) => b[1] - a[1])) { const row = document.createElement('div'); row.className = 'mineral-row'; const pct = (frac * 100).toFixed(1); row.innerHTML = `<span class="name">${name}</span><span class="value">${pct}%</span><div class="mineral-bar"><i style="width:${pct}%"></i></div>`; box.appendChild(row); } } cam.o = { x: S[body.id].x, y: S[body.id].y }; cam.k = Math.max(cam.k, 24 / P.bodies[body.id].radius_m); }
  function pick(x, y) { let chosen, best = Infinity; for (const body of D.bodies) { const p = ws(S[body.id]), anchor = A[body.id] || A.default || {}, r = Math.max(9, radiusOf(body) * (anchor.disk_scale || .848)), score = Math.hypot(p.x - x, p.y - y) / r; if (score <= 1 && score < best) { chosen = body; best = score; } } return chosen; }
  async function openMap() { if (!sel) return; terrain ??= await (await fetch('../data/terrain_manifest.json')).json(); const manifest = terrain.bodies[sel.id]; if (!manifest) return; C.style.display = 'none'; $('mapCanvas').classList.remove('hidden'); $('mapCanvas').style.display = 'block'; $('mapTopbar').classList.remove('hidden'); if (!mapRenderer) mapRenderer = new ExolineMap.MapRenderer($('mapCanvas'), { terrainManifest: manifest, onZoom: zoom => { $('mapReadout').textContent = `MAP · ${zoom.toFixed(1)}×`; } }); await mapRenderer.open(sel, manifest); }
  function closeMission() { $('missionScreen').classList.add('hidden'); $('app').classList.remove('mission-active'); }
  function renderChangelog(markdown) { const target = $('changelogContent'); target.replaceChildren(); let list; for (const line of markdown.split(/\r?\n/)) { if (line.startsWith('### ')) { list = null; const heading = document.createElement('h2'); heading.textContent = line.slice(4); target.append(heading); } else if (line.startsWith('- ')) { if (!list) { list = document.createElement('ul'); target.append(list); } const item = document.createElement('li'); item.textContent = line.slice(2); list.append(item); } else if (line.trim()) { list = null; const paragraph = document.createElement('p'); paragraph.textContent = line.replace(/^# /, ''); target.append(paragraph); } else list = null; } }
  function controls() {
    $('exploreSolBtn').onclick = closeMission; $('continueMissionBtn').onclick = closeMission; $('missionEnter').onclick = closeMission; $('newCampaignBtn').onclick = () => { F.launch('earth', S); nodeAnchors.clear(); ExolineNav.onReset(); ExolineNav.invalidate(); cam.o = { x: F.s.r.x, y: F.s.r.y }; closeMission(); };
    $('changelogBtn').onclick = async () => { $('changelogPanel').classList.remove('hidden'); try { renderChangelog(await (await fetch('../version_change.md', { cache: 'no-store' })).text()); } catch { $('changelogContent').textContent = 'Unable to load version_change.md'; } }; $('closeChangelog').onclick = () => $('changelogPanel').classList.add('hidden');
    const renderKeybinds = () => document.querySelectorAll('[data-bind]').forEach(input => { input.value = bindingLabel(bindings[input.dataset.bind]); });
    const saveBindings = () => localStorage.setItem('exoline.keybinds', JSON.stringify(bindings));
    $('settingsBtn').onclick = () => { renderKeybinds(); $('settingsPanel').classList.remove('hidden'); }; $('closeSettings').onclick = () => $('settingsPanel').classList.add('hidden');
    $('infiniteFuel').onchange = e => { F.infiniteFuel = e.target.checked; showToast(F.infiniteFuel ? 'INFINITE FUEL ENABLED' : 'INFINITE FUEL DISABLED'); };
    const progradeBox = $('progradeLock');
    if (progradeBox) { F.progradeLock = progradeBox.checked !== false; progradeBox.onchange = e => { F.progradeLock = e.target.checked; showToast(F.progradeLock ? 'PROGRADE LOCK ENABLED' : 'PROGRADE LOCK DISABLED'); }; }
    document.querySelectorAll('[data-bind]').forEach(input => {
      input.onclick = () => { input.value = 'PRESS KEY'; input.focus(); };
      input.onkeydown = event => {
        event.preventDefault(); event.stopPropagation();
        const action = input.dataset.bind, duplicate = Object.entries(bindings).find(([name, code]) => name !== action && code === event.code);
        if (duplicate) { showToast(`${bindingLabel(event.code)} ALREADY USED`); renderKeybinds(); return; }
        bindings[action] = event.code; saveBindings(); renderKeybinds(); showToast(`${action.replace(/([A-Z])/g, ' $1').toUpperCase()} · ${bindingLabel(event.code)}`);
      };
    });
    $('resetKeybinds').onclick = () => { bindings = { ...defaultBindings }; saveBindings(); renderKeybinds(); showToast('KEYBINDS RESET'); };
    $('slower').innerHTML = rewindIcon; $('faster').innerHTML = forwardIcon; $('slower').onclick = e => { e.preventDefault(); e.stopPropagation(); setWarp(warpIndex - 1); }; $('faster').onclick = e => { e.preventDefault(); e.stopPropagation(); setWarp(warpIndex + 1); }; $('warpBtn').onclick = e => { e.preventDefault(); e.stopPropagation(); running = !running; updateWarp(); };
    $('throttle').oninput = e => setThrottle(e.target.value); $('turnLeft').onpointerdown = () => keys.right = true; $('turnRight').onpointerdown = () => keys.left = true; addEventListener('pointerup', () => { keys.left = false; keys.right = false; });
    $('launchBtn').onclick = () => { if (autoBurn) { showToast('THROTTLE CONTROLLED BY AUTO BURN'); return; } craftSelected = true; lock = 'craft'; sel = null; focusCraftView(); setThrottle(F.s.throttle > 0 ? 0 : 100); $('launchBtn').textContent = F.s.throttle ? 'CUTOFF' : 'IGNITION'; }; $('rcsBtn').onclick = () => { rcs = !rcs; $('rcsBtn').classList.toggle('is-on', rcs); $('rcsBtn').setAttribute('aria-pressed', String(rcs)); };
    $('orbitNodeAdd').onclick = () => { const seconds = Number($('orbitNodeAdd').dataset.time) || 600; $('orbitNodeAdd').classList.add('hidden'); addNodeForCraft(seconds); };
    $('resetBtn').onclick = () => { lock = null; cam.o = { x: 0, y: 0 }; cam.k = innerHeight / (2.5 * AU); }; $('closeDetail').onclick = () => { $('detailPanel').classList.add('hidden'); sel = null; lock = null; }; $('openMapBtn').onclick = openMap; $('mapResetBtn').onclick = () => mapRenderer?.reset(); $('backBtn').onclick = () => { C.style.display = 'block'; $('mapCanvas').style.display = 'none'; $('mapCanvas').classList.add('hidden'); $('mapTopbar').classList.add('hidden'); };
    $('setTargetBtn').onclick = () => { if (sel && ExolineNav.setTarget(sel.id)) showToast(`TARGET: ${ExolineNav.bodyName(sel.id).toUpperCase()}`); else if (sel) showToast('TARGET UNAVAILABLE'); };
    $('navDetailBtn').onclick = () => $('navExtra').classList.toggle('hidden');
    $('navToggle').onclick = () => $('navPanel').classList.toggle('collapsed');
    $('navClearTarget').onclick = () => { ExolineNav.clearTarget(); showToast('TARGET CLEARED'); };
    $('navNodeBtn').onclick = () => addNodeForCraft();
    $('navFocusCraft').onclick = () => { craftSelected = true; sel = null; lock = 'craft'; focusCraftView(); };
    $('navFocusTarget').onclick = () => { const id = ExolineNav.getTarget(); const body = id && D.bodies.find(b => b.id === id); if (body) { sel = body; craftSelected = false; lock = 'body'; } };
    $('navFit').onclick = () => { lock = null; cam.o = { x: 0, y: 0 }; cam.k = innerHeight / (2.5 * AU); };
    $('resetBtn').onclick = resetView;
    $('navTimeMinus').onclick = () => stepNodeTime(-1); $('navTimePlus').onclick = () => stepNodeTime(1);
    $('navNodeDelete').onclick = () => { if (activeNodeId !== null) { nodeAnchors.delete(activeNodeId); ExolineNav.removeNode(activeNodeId); activeNodeId = null; $('navNode').classList.add('hidden'); showToast('MANEUVER NODE DELETED'); } };
    $('navExecute').onclick = () => autoBurn ? cancelAutoBurn() : startAutoBurn();
    const nodeFields = [['navNodePro', 'progradeDv'], ['navNodeRad', 'radialDv'], ['navNodeNor', 'normalDv']];
    for (const field of nodeFields) { const input = $(field[0]); input.oninput = () => { const nodes = ExolineNav.getNodes(), node = nodes.find(n => n.id === activeNodeId) || nodes[0]; if (node) { ExolineNav.updateNode(node.id, { [field[1]]: input.value }); ExolineNav.setEditing(true); } }; input.onchange = input.onblur = () => ExolineNav.setEditing(false); }

    C.addEventListener('pointerdown', e => {
      const r = C.getBoundingClientRect();
      panning = true;
      panned = false;
      panDrag = { x: e.clientX - r.left, y: e.clientY - r.top, o: { x: cam.o.x, y: cam.o.y } };
      C.setPointerCapture(e.pointerId);
    });
    C.addEventListener('pointermove', e => {
      if (!panning) return;
      const r = C.getBoundingClientRect(), dx = e.clientX - r.left - panDrag.x, dy = e.clientY - r.top - panDrag.y;
      // Dragging always pans; the auto-follow is disabled until the next tap.
      cam.o.x = panDrag.o.x - dx / cam.k;
      cam.o.y = panDrag.o.y + dy / cam.k;
    });
    C.addEventListener('pointerup', e => {
      const moved = panning && Math.hypot(e.clientX - panDrag.x, e.clientY - panDrag.y) >= 4;
      panning = false;
      const r = C.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
      if (moved) { panned = true; return; }
      const nodeHit = nodeHitRegions.find(hit => Math.hypot(hit.x - x, hit.y - y) <= hit.radius);
      if (nodeHit) {
        activeNodeId = nodeHit.id; $('navNode').classList.remove('hidden'); $('navPanel').classList.remove('collapsed'); ExolineNav.setEditing(true);
        setTimeout(() => ExolineNav.setEditing(false), 500);
        return;
      }
      const orbitHit = orbitHitRegions.reduce((best, point) => !best || Math.hypot(point.x - x, point.y - y) < best.distance ? { point, distance: Math.hypot(point.x - x, point.y - y) } : best, null);
      if (orbitHit && orbitHit.distance <= 18) {
        const button = $('orbitNodeAdd'); button.dataset.time = String(orbitHit.point.t); button.style.left = `${Math.min(innerWidth - 104, x + 10)}px`; button.style.top = `${Math.min(innerHeight - 34, y + 10)}px`; button.classList.remove('hidden');
        return;
      }
      const ship = ws(F.s.r), hit = pick(x, y);
      if (Math.hypot(ship.x - x, ship.y - y) < 22) {
        craftSelected = true; sel = null; lock = 'craft'; cam.o = { x: F.s.r.x, y: F.s.r.y }; focusCraftView(); $('detailPanel').classList.add('hidden');
      } else if (hit) {
        inspect(hit);
      } else {
        sel = null; craftSelected = false; lock = null; $('detailPanel').classList.add('hidden');
      }
    });
    C.addEventListener('wheel', e => {
      e.preventDefault();
      const r = C.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
      const before = sw(x, y), factor = e.deltaY < 0 ? 1.22 : 1 / 1.22;
      cam.k = Math.max(1e-12, cam.k * factor);
      const after = sw(x, y);
      cam.o.x += before.x - after.x;
      cam.o.y += before.y - after.y;
    }, { passive: false });
    addEventListener('keydown', e => {
      if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
      if (matches(e, 'pause')) { e.preventDefault(); running = !running; updateWarp(); }
      if (matches(e, 'warpDown')) { e.preventDefault(); setWarp(warpIndex - 1); }
      if (matches(e, 'warpUp')) { e.preventDefault(); setWarp(warpIndex + 1); }
      const node = ExolineNav.getNodes().find(n => n.id === activeNodeId);
      if (node) {
        const amount = e.shiftKey ? 100 : 10;
        const patch = e.key === 'w' || e.key === 'W' ? { progradeDv: node.progradeDv + amount } : e.key === 's' || e.key === 'S' ? { progradeDv: node.progradeDv - amount } : e.key === 'd' || e.key === 'D' ? { radialDv: node.radialDv + amount } : e.key === 'a' || e.key === 'A' ? { radialDv: node.radialDv - amount } : e.key === 'e' || e.key === 'E' ? { normalDv: node.normalDv + amount } : e.key === 'q' || e.key === 'Q' ? { normalDv: node.normalDv - amount } : null;
        if (patch) { e.preventDefault(); ExolineNav.updateNode(node.id, patch); ExolineNav.setEditing(true); setTimeout(() => ExolineNav.setEditing(false), 300); return; }
        if (e.key === ',' || e.key === '<') { e.preventDefault(); stepNodeTime(-1); return; }
        if (e.key === '.' || e.key === '>') { e.preventDefault(); stepNodeTime(1); return; }
      }
      if (e.key === 'ArrowUp') { e.preventDefault(); keys.pan.up = true; }
      if (e.key === 'ArrowDown') { e.preventDefault(); keys.pan.down = true; }
      if (e.key === 'ArrowLeft') { e.preventDefault(); keys.pan.left = true; }
      if (e.key === 'ArrowRight') { e.preventDefault(); keys.pan.right = true; }
      if (e.key === 't' || e.key === 'T') { if (sel && ExolineNav.isTargetable(sel.id)) { ExolineNav.setTarget(sel.id); showToast(`TARGET: ${ExolineNav.bodyName(sel.id).toUpperCase()}`); } }
      if (e.key === 'c' || e.key === 'C') { if (ExolineNav.getTarget()) { ExolineNav.clearTarget(); showToast('TARGET CLEARED'); } }
      if (matches(e, 'addNode')) addNodeForCraft();
      if (matches(e, 'focusCraft')) { craftSelected = true; sel = null; lock = 'craft'; focusCraftView(); }
      if (matches(e, 'resetView')) resetView();
      if (matches(e, 'autoBurn')) { if (autoBurn) cancelAutoBurn(); else startAutoBurn(); }
    });
    addEventListener('keyup', e => {
      if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
      if (e.key === 'w' || e.key === 'W' || e.key === 's' || e.key === 'S' || e.key === 'a' || e.key === 'A' || e.key === 'd' || e.key === 'D' || e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        keys.pan.up = false; keys.pan.down = false; keys.pan.left = false; keys.pan.right = false;
      }
    });
  }
  async function frame(now) {
    frameCount++;
    const realSeconds = Math.min(.1, (now - lastFrame) / 1000); lastFrame = now;
    if (running) {
      const requestedSeconds = realSeconds * WARP[warpIndex];
      // Never advance the ephemeris farther than the craft integrator has
      // advanced.  The previous mismatch made a de-orbit see planets/sun at a
      // future epoch and produced non-physical energy changes.
      simulationBacklog += requestedSeconds;
      // The initial circular hold is an exact phase solution, so it can safely
      // absorb any warp interval. Perturbed/de-orbit motion is still RK4
      // stepped, but a 10k warp must be allowed to consume roughly its full
      // requested interval instead of being pinned to five seconds/frame.
      const exactCoast = F.circularHold && F.s.throttle === 0 && !autoBurn;
      const integrationBudget = Math.min(1200, Math.max(5, requestedSeconds));
      const physicsSeconds = exactCoast ? simulationBacklog : Math.min(integrationBudget, simulationBacklog);
      simulationBacklog = Math.max(0, simulationBacklog - physicsSeconds);
      F.s.heading += (Number(!!keys.right) - Number(!!keys.left)) * (rcs ? .7 : 2.2) * realSeconds;
      F.manualSteer = !!(keys.left || keys.right);
      F.steerOverride = !!autoBurn;
      try {
        if (exactCoast) {
          // Analytic circular hold: exact at any warp, single step.
          updateAutoBurn(physicsSeconds); F.step(physicsSeconds, S); finishAutoBurn(physicsSeconds);
          date = new Date(+date + physicsSeconds * 1000);
          await updateStates(); F.syncCircularHold(S);
        } else {
          // Perturbed flight: split into <=120 s chunks with a fresh ephemeris
          // each chunk, so high warp can't inject energy via stale body
          // positions (linear extrapolation error grows with t^2).
          let remaining = physicsSeconds;
          while (remaining > 1e-9) {
            const chunk = Math.min(120, remaining);
            updateAutoBurn(chunk); F.step(chunk, S); finishAutoBurn(chunk);
            date = new Date(+date + chunk * 1000);
            await updateStates(); F.syncCircularHold(S);
            remaining -= chunk;
            if (!running) break;
          }
        }
        if (window.ExolinePhysicsAgent) window.ExolinePhysicsAgent.check(frameCount, F, S);
      } catch (error) { console.warn('Flight integration paused:', error); running = false; simulationBacklog = 0; }
    }
    draw(); requestAnimationFrame(frame);
  }
  async function start() { [D, P, A, minerals] = await Promise.all(['solar_system.json', 'physics_constants.json', 'render_anchors.json', 'mineral_profiles.json'].map(async file => (await fetch('../data/' + file)).json())); await ExolineOrbit.load(); await updateStates(); F = new ExolineFlight.Flight(P); F.launch('earth', S); ExolineNav.init({ catalog: D, constants: P, flight: F, getBodies: () => S, getDate: () => date, getRefId: () => soiBody()?.id || F.dominant(S) }); resize(); controls(); setWarp(0); setTimeout(() => { $('introScreen')?.classList.add('is-exiting'); setTimeout(() => { $('introScreen')?.remove(); $('missionScreen')?.classList.remove('hidden'); $('app')?.classList.add('mission-active'); }, 850); }, 4200); requestAnimationFrame(frame); }
  addEventListener('resize', resize);
  start().catch(error => {
    // Do not leave the player behind an opaque splash screen if data or a
    // script fails during startup. The console preserves the technical cause.
    console.error('EXOLINE startup failed:', error);
    $('introScreen')?.remove();
    const loading = $('loading');
    loading?.classList.remove('hidden');
    if ($('loadingText')) $('loadingText').textContent = 'STARTUP ERROR — OPEN CONSOLE';
  });
})();
