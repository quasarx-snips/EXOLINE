
window.ExolineOrbit = (() => {
  const DAY_MS = 86400000;
  const AU_KM = 149597870.7;
  const J2000 = 2451545.0;

  let raw = null;
  let cache = null;

  async function load() {
    if (raw) return raw;
    const response = await fetch('../data/orbital_elements.json', { cache: 'no-store' });
    if (!response.ok) throw new Error(`Orbital data HTTP ${response.status}`);
    raw = await response.json();
    return raw;
  }

  function toJD(date) {
    return date.getTime() / DAY_MS + 2440587.5;
  }

  function normDeg(v) {
    v %= 360;
    if (v < 0) v += 360;
    return v;
  }

  function solveKepler(Mrad, e) {
    let E = e < 0.8 ? Mrad : Math.PI;
    for (let i = 0; i < 12; i++) {
      const f = E - e * Math.sin(E) - Mrad;
      const fp = 1 - e * Math.cos(E);
      const d = f / fp;
      E -= d;
      if (Math.abs(d) < 1e-11) break;
    }
    return E;
  }

  function primaryState(id, date) {
    const base = raw.primary[id];
    if (!base) return null;

    const T = (toJD(date) - J2000) / 36525;
    const a = base.a + base.ad * T;
    const e = Math.max(0, base.e + base.ed * T);
    const inc = (base.i + base.id * T) * Math.PI / 180;
    const L = base.L + base.Ld * T;
    const lp = base.p + base.pd * T;
    const node = (base.node + base.noded * T) * Math.PI / 180;
    const M = normDeg(L - lp) * Math.PI / 180;
    const E = solveKepler(M, e);

    const xOrb = a * (Math.cos(E) - e);
    const yOrb = a * Math.sqrt(1 - e * e) * Math.sin(E);

    const omega = lp * Math.PI / 180 - node;
    const cosO = Math.cos(node), sinO = Math.sin(node);
    const cosw = Math.cos(omega), sinw = Math.sin(omega);
    const cosi = Math.cos(inc), sini = Math.sin(inc);

    const x = (cosO * cosw - sinO * sinw * cosi) * xOrb + (-cosO * sinw - sinO * cosw * cosi) * yOrb;
    const y = (sinO * cosw + cosO * sinw * cosi) * xOrb + (-sinO * sinw + cosO * cosw * cosi) * yOrb;
    const z = (sinw * sini) * xOrb + (cosw * sini) * yOrb;

    return { x, y, z, r: Math.hypot(x, y, z), a, e, periodDays: 365.2568983 * Math.pow(a, 1.5) };
  }

  function dwarfState(id, date) {
    const base = raw.dwarfs[id];
    if (!base) return null;
    const ref = new Date('2000-01-01T12:00:00Z');
    const days = (date - ref) / DAY_MS;
    const n = 2 * Math.PI / base.period_days;
    // The catalogued L value is mean longitude, so remove longitude of
    // periapsis before advancing the mean anomaly with Kepler's law.
    const meanAnomalyAtEpoch = (base.L - base.p) * Math.PI / 180;
    const M = meanAnomalyAtEpoch + n * days;
    const E = solveKepler(M % (2*Math.PI), base.e);
    const xOrb = base.a * (Math.cos(E) - base.e);
    const yOrb = base.a * Math.sqrt(1 - base.e * base.e) * Math.sin(E);
    const inc = base.i * Math.PI / 180;
    const node = base.node * Math.PI / 180;
    const omega = base.p * Math.PI / 180 - node;
    const cosO=Math.cos(node), sinO=Math.sin(node), cosw=Math.cos(omega), sinw=Math.sin(omega), cosi=Math.cos(inc), sini=Math.sin(inc);
    const x=(cosO*cosw-sinO*sinw*cosi)*xOrb+(-cosO*sinw-sinO*cosw*cosi)*yOrb;
    const y=(sinO*cosw+cosO*sinw*cosi)*xOrb+(-sinO*sinw+cosO*cosw*cosi)*yOrb;
    const z=(sinw*sini)*xOrb+(cosw*sini)*yOrb;
    return {x,y,z,r:Math.hypot(x,y,z),a:base.a,e:base.e,periodDays:base.period_days};
  }

  function moonState(id, date) {
    const base = raw.moons[id];
    if (!base) return null;
    const ref = new Date('2000-01-01T12:00:00Z');
    const days = (date - ref) / DAY_MS;
    const M = (base.M * Math.PI / 180) + 2 * Math.PI * days / base.period_days;
    const E = solveKepler(M % (2*Math.PI), base.e);
    const aAU = base.a_km / AU_KM;
    const xOrb = aAU * (Math.cos(E) - base.e);
    const yOrb = aAU * Math.sqrt(1 - base.e * base.e) * Math.sin(E);
    const inc = base.i * Math.PI/180, node=base.node*Math.PI/180, omega=(base.omega*Math.PI/180)-node;
    const cosO=Math.cos(node), sinO=Math.sin(node), cosw=Math.cos(omega), sinw=Math.sin(omega), cosi=Math.cos(inc), sini=Math.sin(inc);
    return {
      x:(cosO*cosw-sinO*sinw*cosi)*xOrb+(-cosO*sinw-sinO*cosw*cosi)*yOrb,
      y:(sinO*cosw+cosO*sinw*cosi)*xOrb+(-sinO*sinw+cosO*cosw*cosi)*yOrb,
      z:(sinw*sini)*xOrb+(cosw*sini)*yOrb,
      r:aAU, periodDays:base.period_days
    };
  }

  function state(id, date) {
    if (raw.primary[id]) return primaryState(id, date);
    if (raw.dwarfs[id]) return dwarfState(id, date);
    return null;
  }

  async function positions(date) {
    if (!raw) await load();
    const result = {};
    for (const id of Object.keys(raw.primary)) result[id] = primaryState(id, date);
    for (const id of Object.keys(raw.dwarfs)) result[id] = dwarfState(id, date);
    return result;
  }

  function orbitPath(id, segments=240, date=new Date('2000-01-01T12:00:00Z')) {
    if (!raw) return [];
    const base = raw.primary[id] || raw.dwarfs[id];
    if (!base) return [];

    const points=[];
    const T=(toJD(date)-J2000)/36525;
    const a=base.a+(base.ad||0)*T;
    const e=Math.max(0,base.e+(base.ed||0)*T);
    const inc=((base.i||0)+(base.id||0)*T)*Math.PI/180;
    const node=((base.node||0)+(base.noded||0)*T)*Math.PI/180;
    const omega=((base.p||0)+(base.pd||0)*T)*Math.PI/180-node;
    const cosO=Math.cos(node), sinO=Math.sin(node), cosw=Math.cos(omega), sinw=Math.sin(omega), cosi=Math.cos(inc), sini=Math.sin(inc);

    for (let i=0;i<segments;i++) {
      const M=2*Math.PI*i/segments;
      const E=solveKepler(M,e);
      const xOrb=a*(Math.cos(E)-e);
      const yOrb=a*Math.sqrt(1-e*e)*Math.sin(E);
      const x=(cosO*cosw-sinO*sinw*cosi)*xOrb+(-cosO*sinw-sinO*cosw*cosi)*yOrb;
      const y=(sinO*cosw+cosO*sinw*cosi)*xOrb+(-sinO*sinw+cosO*cosw*cosi)*yOrb;
      const z=(sinw*sini)*xOrb+(cosw*sini)*yOrb;
      points.push({x,y,z});
    }
    return points;
  }

  function moonOrbitPath(id, segments=96) {
    if (!raw || !raw.moons[id]) return [];
    const base=raw.moons[id],a=base.a_km/AU_KM,e=base.e||0;
    const inc=(base.i||0)*Math.PI/180,node=(base.node||0)*Math.PI/180;
    const omega=(base.omega||0)*Math.PI/180-node;
    const cosO=Math.cos(node),sinO=Math.sin(node),cosw=Math.cos(omega),sinw=Math.sin(omega);
    const cosi=Math.cos(inc),sini=Math.sin(inc),points=[];
    for(let i=0;i<segments;i++){
      const E=solveKepler(2*Math.PI*i/segments,e);
      const xOrb=a*(Math.cos(E)-e),yOrb=a*Math.sqrt(1-e*e)*Math.sin(E);
      points.push({
        x:(cosO*cosw-sinO*sinw*cosi)*xOrb+(-cosO*sinw-sinO*cosw*cosi)*yOrb,
        y:(sinO*cosw+cosO*sinw*cosi)*xOrb+(-sinO*sinw+cosO*cosw*cosi)*yOrb,
        z:(sinw*sini)*xOrb+(cosw*sini)*yOrb
      });
    }
    return points;
  }

  async function moon(id, date) { if (!raw) await load(); return moonState(id,date); }

  return { load, positions, state, orbitPath, moonOrbitPath, moon, toJD };
})();
