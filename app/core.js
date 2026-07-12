/* ============================================================
   FlyAlarm functional core v1.0 — full rewrite.
   Sites: ParaglidingEarth (around-point or country-wide) merged
   with a small verified pack. Weather: Open-Meteo surface +
   pressure-level profile (925/850/700 hPa) — the Skew-T-derived
   layer: lapse rate, thermal tops, cloudbase, inversions,
   wind at launch height, shear.
   ============================================================ */

/* ---------------- pilot profiles ---------------- */
const TIERS = {
  conservative: {
    key: 'conservative', label: 'Conservative',
    windMax: 14, gustMax: 24, spreadMax: 12, aloftMax: 20, shearOk: 10,
    capeMax: 900,  ppMax: 40, thermalMaxIdx: 0.55, windIdeal: [4, 11], winRef: 4,
    w: { wind: 0.50, thermal: 0.45, band: 0.05 },
    blurb: 'A safe day for a novice pilot: light steady wind, gentle climbs, no surprises.'
  },
  standard: {
    key: 'standard', label: 'Standard',
    windMax: 19, gustMax: 30, spreadMax: 15, aloftMax: 28, shearOk: 15,
    capeMax: 1400, ppMax: 55, thermalMaxIdx: 99, windIdeal: [5, 15], winRef: 6,
    w: { wind: 0.45, thermal: 0.45, band: 0.10 },
    blurb: 'A capable club pilot: real thermals and more demanding air are fine.'
  },
  performance: {
    key: 'performance', label: 'Performance',
    windMax: 25, gustMax: 38, spreadMax: 18, aloftMax: 35, shearOk: 20,
    capeMax: 1900, ppMax: 60, thermalMaxIdx: 99, windIdeal: [6, 17], winRef: 8,
    w: { wind: 0.35, thermal: 0.40, band: 0.25 },
    blurb: 'Top days: strong climbs, high bases, long windows \u2014 XC potential.'
  },
};
const STORM_CAPE = 2200, STORM_PP = 30;
const DAY_START = 8, DAY_END = 19;
const FLYABLE_SCORE = 6;



/* ---------------- helpers ---------------- */
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const LETTER_DEG = { N:0, NNE:22.5, NE:45, ENE:67.5, E:90, ESE:112.5, SE:135, SSE:157.5,
  S:180, SSW:202.5, SW:225, WSW:247.5, W:270, WNW:292.5, NW:315, NNW:337.5 };
const COMPASS = Object.keys(LETTER_DEG);
const dirToCompass = d => COMPASS[Math.round(((d % 360) + 360) % 360 / 22.5) % 16];
const angDist = (a, b) => { const d = Math.abs(((a - b) % 360 + 360) % 360); return Math.min(d, 360 - d); };
const dirAllowed = (deg, degList, tol = 30) => degList.some(c => angDist(deg, c) <= tol);
function meanDir(degs) {
  let sx = 0, sy = 0;
  for (const d of degs) { const r = d * Math.PI / 180; sx += Math.cos(r); sy += Math.sin(r); }
  return (Math.atan2(sy, sx) * 180 / Math.PI + 360) % 360;
}
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371, toR = x => x * Math.PI / 180;
  const dLat = toR(lat2 - lat1), dLon = toR(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toR(lat1)) * Math.cos(toR(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
function prepSite(s) {
  s.dirs = (s.dirs || []).filter(l => l in LETTER_DEG);
  const good = new Set((s.dirsGood && s.dirsGood.length ? s.dirsGood : s.dirs));
  s._degs = s.dirs.map(l => LETTER_DEG[l]);
  s._degsW = s.dirs.map(l => ({ deg: LETTER_DEG[l], w: good.has(l) ? 1 : 0.8 }));
  s.sectorUnknown = s._degs.length === 0;
  return s;
}
function dirQuality(deg, site) {
  if (site.sectorUnknown || !site._degsW.length) return 1;
  let best = 0;
  for (const c of site._degsW) {
    const off = angDist(deg, c.deg);
    if (off > 30) continue;
    best = Math.max(best, c.w * (1 - 0.35 * off / 30));
  }
  return best ? Math.max(0.55, best) : 1;
}
function axisOffset(deg, site) {
  if (site.sectorUnknown || !site._degsW.length) return null;
  return Math.round(Math.min(...site._degsW.map(c => angDist(deg, c.deg))));
}

/* ---------------- ParaglidingEarth parsing (tolerant) ---------------- */
function parsePEFeatures(geojson) {
  const feats = geojson?.features || [];
  const sites = [];
  feats.forEach((f, i) => {
    const c = f?.geometry?.coordinates;
    if (!c || c.length < 2) return;
    const p = f.properties || {};
    const val = L => {
      const src = (p.orientations && typeof p.orientations === 'object') ? p.orientations : p;
      const v = src[L] ?? src[L.toLowerCase()];
      return v === 2 || v === '2' ? 2 : (v === 1 || v === '1' || v === true ? 1 : 0);
    };
    let dirs = COMPASS.filter(L => val(L) >= 1);
    let dirsGood = COMPASS.filter(L => val(L) === 2);
    if (!dirs.length && typeof p.orientations === 'string') {
      dirs = p.orientations.split(/[,; ]+/).map(x => x.trim().toUpperCase()).filter(x => x in LETTER_DEG);
      dirsGood = dirs.slice();
    }
    const alt = parseInt(p.takeoff_altitude ?? p.altitude ?? p.alt ?? '', 10);
    const tags = ['xc','thermals','soaring','flatland','winch','hike']
      .filter(t => { const v = p[t]; return v === 1 || v === '1' || v === true; });
    const peId = p.pge_site_id ?? p.id ?? null;
    sites.push(prepSite({
      id: 'pe' + (peId ?? i),
      name: p.name || 'Unnamed site',
      lat: c[1], lon: c[0],
      alt: Number.isFinite(alt) ? alt : null,
      country: (p.countryCode || p.country_code || '').toString().toUpperCase(),
      link: p.pge_link || (peId != null ? 'https://www.paraglidingearth.com/pgearth/index.php?site=' + peId : null),
      dirs, dirsGood, tags, source: 'pe', approx: false,
    }));
  });
  return sites;
}

/* ---------------- the Skew-T layer ---------------- */
const LEVELS = [{ p: 925, h: 760 }, { p: 850, h: 1460 }, { p: 700, h: 3010 }];
const DALR = 0.0098; /* \u00b0C per m */

/* Derive profile metrics for one hour at one site. Returns null without profile data. */
function deriveHour(row, siteAlt) {
  if (row.t2m == null) return null;
  const env = [{ h: Math.max(siteAlt, 0), t: row.t2m }];
  for (const L of LEVELS) {
    const t = row['t' + L.p];
    if (t != null && L.h > env[env.length - 1].h) env.push({ h: L.h, t });
  }
  if (env.length < 2) return null;

  /* lapse in the working band (surface -> ~850) */
  const bandTop = env.find(e => e.h >= siteAlt + 800) || env[env.length - 1];
  const lapse = (env[0].t - bandTop.t) / Math.max(1, bandTop.h - env[0].h) * 100; /* \u00b0C/100 m */

  /* inversion below ~site+2000 */
  let capH = null;
  for (let i = 0; i < env.length - 1; i++) {
    if (env[i + 1].t > env[i].t + 0.3 && env[i].h < siteAlt + 2200) { capH = env[i].h; break; }
  }

  /* parcel from surface along DALR vs environment -> thermal top */
  let top = env[env.length - 1].h;
  for (let i = 0; i < env.length - 1; i++) {
    const a = env[i], b = env[i + 1];
    const pa = env[0].t - DALR * (a.h - env[0].h), pb = env[0].t - DALR * (b.h - env[0].h);
    const da = pa - a.t, db = pb - b.t;              /* parcel minus environment */
    if (da >= 0 && db < 0) { top = a.h + (b.h - a.h) * (da / (da - db)); break; }
    if (da < 0) { top = a.h; break; }
  }
  if (capH != null) top = Math.min(top, capH);

  /* cloudbase (LCL) from 2 m spread, referenced to site elevation */
  const base = row.td2m != null ? env[0].h + 122 * Math.max(0, row.t2m - row.td2m) : null;

  /* wind at launch height: interpolate 10 m + levels */
  const pts = [{ h: env[0].h + 10, ws: row.wind, wd: row.dir }];
  for (const L of LEVELS) {
    const ws = row['ws' + L.p], wd = row['wd' + L.p];
    if (ws != null && wd != null) pts.push({ h: L.h, ws, wd });
  }
  pts.sort((a, b) => a.h - b.h);
  const target = siteAlt + 50;
  let windL = pts[0];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    if (target >= a.h && target <= b.h) {
      const f = (target - a.h) / Math.max(1, b.h - a.h);
      const toUV = p => [ -p.ws * Math.sin(p.wd * Math.PI / 180), -p.ws * Math.cos(p.wd * Math.PI / 180) ];
      const [ua, va] = toUV(a), [ub, vb] = toUV(b);
      const u = ua + f * (ub - ua), v = va + f * (vb - va);
      windL = { h: target, ws: Math.hypot(u, v), wd: (Math.atan2(-u, -v) * 180 / Math.PI + 360) % 360 };
      break;
    }
    windL = b;
  }
  const shear = Math.abs(windL.ws - row.wind) + angDist(windL.wd, row.dir) / 12;

  return { lapse, capH, top, base, windL, shear };
}

/* ---------------- meteo derivations ---------------- */
function estimateSWR(hourLocal, monthIdx, cloudCover) {
  const solar = Math.max(0, Math.sin(Math.PI * (hourLocal - 6) / 13));
  const season = [0.35,0.45,0.60,0.75,0.90,1.0,1.0,0.90,0.72,0.55,0.40,0.32][monthIdx];
  return 900 * solar * season * (1 - 0.75 * (cloudCover ?? 30) / 100);
}
function thermalIndex(row, prof) {
  const heat = clamp((row.swr ?? 0) / 750, 0, 1.3);
  const cc = row.cc ?? 30;
  const cF = cc <= 60 ? 1 : (cc <= 85 ? 0.7 : 0.4);
  if (!prof) return heat * cF;
  const lapseF = clamp((prof.lapse - 0.45) / 0.4, 0, 1.15);
  const invF = prof.capH == null ? 1 : 0.5;
  return heat * cF * lapseF * invF;
}
const thermalLabel = idx =>
  idx < 0.15 ? 'none' : idx < 0.35 ? 'weak' : idx < 0.7 ? 'moderate' : idx < 1.0 ? 'strong' : 'very strong';

function windQuality(w, tier) {
  const [lo, hi] = tier.windIdeal;
  if (w <= lo) return 0.6;
  if (w <= hi) return 1;
  return clamp(1 - (w - hi) / Math.max(1, tier.windMax * 1.05 - hi), 0, 1);
}
function thermalQuality(idx, tier) {
  const tri = (x, a, p, b) =>
    x <= a || x >= b ? 0.1 : x <= p ? 0.1 + 0.9 * (x - a) / (p - a) : 0.1 + 0.9 * (b - x) / (b - p);
  if (tier.key === 'conservative') return tri(idx, 0.03, 0.35, 0.75);
  if (tier.key === 'standard')     return tri(idx, 0.08, 0.60, 1.05);
  return clamp(idx / 0.9, 0.1, 1);
}

/* ---------------- per-hour evaluation ---------------- */
function evalHour(h, tier, site) {
  const gates = [], soft = [];
  const prof = deriveHour(h, site.alt || 500);

  if ((h.precip ?? 0) > 0.1 || (h.pp ?? 0) > tier.ppMax) gates.push('rain');
  if ((h.cape ?? 0) >= STORM_CAPE && (h.pp ?? 0) >= STORM_PP) gates.push('storm');
  else if ((h.cape ?? 0) > tier.capeMax) gates.push('cape');
  if (h.wind > tier.windMax) gates.push('wind');
  if (h.gust > tier.gustMax) gates.push('gust');
  if (h.gust - h.wind > tier.spreadMax) gates.push('gustspread');
  if (prof && prof.windL.ws > tier.aloftMax) gates.push('aloftwind');
  const gateDir = prof && prof.windL.ws > 8 ? prof.windL.wd : (h.wind > 6 ? h.dir : null);
  if (gateDir != null && !site.sectorUnknown && !dirAllowed(gateDir, site._degs)) gates.push('direction');

  const idx = thermalIndex(h, prof);
  if (gates.length === 0 && idx > tier.thermalMaxIdx) soft.push('strongthermals');

  const dQ = (h.wind > 6 && !site.sectorUnknown) ? dirQuality(h.dir, site) : 1;
  const bandQ = prof ? clamp((prof.top - (site.alt || 500)) / 1500, 0, 1) : 0.5;
  const shearPen = prof ? clamp((prof.shear - tier.shearOk) / 40, 0, 0.25) : 0;
  const q = clamp(
    tier.w.wind * windQuality(h.wind, tier) * dQ +
    tier.w.thermal * thermalQuality(idx, tier) +
    tier.w.band * bandQ - shearPen, 0, 1);

  const state = gates.length ? 'gated' : soft.length ? 'soft' : (q >= 0.6 ? 'good' : 'ok');
  return { hour: h.hour, state, q, idx, gates, soft, prof, raw: h };
}

/* ---------------- reasons ---------------- */
function fmtRanges(hours) {
  if (!hours.length) return '';
  const out = []; let a = hours[0], b = hours[0];
  for (let i = 1; i < hours.length; i++) {
    if (hours[i] === b + 1) b = hours[i]; else { out.push([a, b]); a = b = hours[i]; }
  }
  out.push([a, b]);
  return out.map(([x, y]) => `${x}:00\u2013${y + 1}:00`).join(', ');
}
const GATE_TEXT = {
  storm:      (h, s) => `Storm risk ${fmtRanges(h)} (CAPE up to ${s.capeMax} J/kg + precip)`,
  rain:       (h)    => `Rain / high precip probability ${fmtRanges(h)}`,
  cape:       (h, s) => `Overdevelopment risk ${fmtRanges(h)} (CAPE up to ${s.capeMax} J/kg)`,
  wind:       (h, s) => `Wind over limit ${fmtRanges(h)} (max ${s.windMaxSeen} km/h)`,
  gust:       (h, s) => `Gusts over limit ${fmtRanges(h)} (max ${s.gustMax} km/h)`,
  gustspread: (h)    => `Turbulent gust spread ${fmtRanges(h)}`,
  aloftwind:  (h, s) => `Wind at launch height over limit ${fmtRanges(h)} (max ${s.aloftMax} km/h)`,
  direction:  (h, s) => `Wind out of sector (mostly ${s.badDir}) ${fmtRanges(h)}`,
  strongthermals: (h) => `Midday thermals too strong for this profile ${fmtRanges(h)}`,
};

/* ---------------- per-day scoring ---------------- */
function scoreDay(dayHours, site, tier) {
  const hours = dayHours
    .filter(h => h.hour >= DAY_START && h.hour <= DAY_END)
    .map(h => evalHour(h, tier, site));
  const flyable = hours.filter(x => x.state === 'good' || x.state === 'ok');

  let win = { from: null, to: null, len: 0 }, curFrom = null, curLen = 0;
  for (const x of hours) {
    if (x.state === 'good' || x.state === 'ok') {
      if (curFrom === null) curFrom = x.hour;
      curLen++;
      if (curLen > win.len) win = { from: curFrom, to: x.hour, len: curLen };
    } else { curFrom = null; curLen = 0; }
  }
  const meanQ = flyable.length ? flyable.reduce((s, x) => s + x.q, 0) / flyable.length : 0;
  let score = flyable.length === 0 ? 0
    : Math.round(10 * (0.55 * clamp(win.len / tier.winRef, 0, 1) + 0.45 * meanQ));

  const warnings = [];
  const stormHrs = hours.filter(x => x.gates.includes('storm')).map(x => x.hour);
  if (stormHrs.length) { warnings.push('storm'); score = Math.min(score, 4); }
  if (site.sectorUnknown && score > 5) score = 5;

  const verdict = score === 0 ? 'No fly'
    : site.sectorUnknown ? 'Unverified'
    : score <= 3 ? 'Poor' : score <= 5 ? 'Marginal' : score <= 7 ? 'Good' : "Don't miss";

  const raw = hours.map(x => x.raw);
  const winProfs = (flyable.length ? flyable : hours).map(x => x.prof).filter(Boolean);
  const stats = {
    windMin: Math.round(Math.min(...raw.map(r => r.wind))),
    windMaxSeen: Math.round(Math.max(...raw.map(r => r.wind))),
    gustMax: Math.round(Math.max(...raw.map(r => r.gust))),
    capeMax: Math.round(Math.max(...raw.map(r => r.cape ?? 0))),
    aloftMax: Math.round(Math.max(0, ...hours.map(x => x.prof ? x.prof.windL.ws : 0))),
    thermalPeak: Math.max(...hours.map(x => x.idx)),
    topMax: winProfs.length ? Math.round(Math.max(...winProfs.map(p => p.top)) / 50) * 50 : null,
    baseTyp: winProfs.length && winProfs.some(p => p.base != null)
      ? Math.round(Math.max(...winProfs.filter(p => p.base != null).map(p => p.base)) / 50) * 50 : null,
    lapseMax: winProfs.length ? Math.max(...winProfs.map(p => p.lapse)) : null,
    capMin: winProfs.some(p => p.capH != null)
      ? Math.min(...winProfs.filter(p => p.capH != null).map(p => p.capH)) : null,
  };
  const gatedDir = hours.filter(x => x.gates.includes('direction')).map(x => x.prof && x.prof.windL.ws > 8 ? x.prof.windL.wd : x.raw.dir);
  stats.badDir = gatedDir.length ? dirToCompass(gatedDir.reduce((a, b) => a + b, 0) / gatedDir.length) : '';

  const reasons = [];
  if (stormHrs.length) reasons.push('\u26a1 ' + GATE_TEXT.storm(stormHrs, stats));
  if (site.sectorUnknown) reasons.push('\u26a0 Takeoff directions unknown \u2014 wind direction NOT checked. Score capped at 5; verify locally.');
  if (win.len) {
    reasons.push(`Usable window ${win.from}:00\u2013${win.to + 1}:00 (${win.len} h)`);
    const fw = flyable.map(x => x.raw.wind), fd = flyable.map(x => x.raw.dir);
    const mD = meanDir(fd);
    const off = axisOffset(mD, site);
    const axis = off == null ? '' : off <= 12 ? ' \u2014 straight in' : ` \u2014 ${off}\u00b0 off axis`;
    reasons.push(`${site.sectorUnknown ? '' : 'In-sector '}${dirToCompass(mD)} wind ${Math.round(Math.min(...fw))}\u2013${Math.round(Math.max(...fw))} km/h${axis}`);
    if (stats.topMax != null && stats.baseTyp != null) {
      reasons.push(stats.baseTyp > stats.topMax + 200
        ? `Blue day \u2014 thermal tops ~${stats.topMax} m, base above them`
        : `Cloudbase ~${stats.baseTyp} m \u00b7 thermal tops ~${stats.topMax} m (${Math.max(0, stats.topMax - (site.alt || 0))} m over launch)`);
    }
    if (stats.capMin != null && stats.capMin < (site.alt || 0) + 900)
      reasons.push(`Inversion caps climbs near ${Math.round(stats.capMin / 50) * 50} m`);
    reasons.push(`Thermal potential: ${thermalLabel(stats.thermalPeak)}`);
  }
  const gateCodes = ['gust','wind','aloftwind','direction','rain','cape','gustspread','strongthermals'];
  for (const code of gateCodes) {
    if (reasons.length >= 6) break;
    const hrs = hours.filter(x => x.gates.includes(code) || x.soft.includes(code)).map(x => x.hour);
    if (hrs.length >= 2) reasons.push(GATE_TEXT[code](hrs, stats));
  }
  return { score, verdict, window: win, hours, reasons: reasons.slice(0, 6), warnings, stats };
}

/* ---------------- forecast plumbing ---------------- */
function normalizeHourly(hourly) {
  const n = hourly.time.length, rows = [];
  for (let i = 0; i < n; i++) {
    const t = hourly.time[i];
    const hour = parseInt(t.slice(11, 13), 10);
    const cc = hourly.cloud_cover?.[i];
    const monthIdx = parseInt(t.slice(5, 7), 10) - 1;
    const row = {
      date: t.slice(0, 10), hour,
      precip: hourly.precipitation?.[i] ?? 0,
      pp: hourly.precipitation_probability?.[i] ?? 0,
      cc,
      wind: hourly.wind_speed_10m?.[i] ?? 0,
      dir: hourly.wind_direction_10m?.[i] ?? 0,
      gust: hourly.wind_gusts_10m?.[i] ?? 0,
      cape: hourly.cape?.[i] ?? 0,
      t2m: hourly.temperature_2m?.[i],
      td2m: hourly.dew_point_2m?.[i],
      swr: hourly.shortwave_radiation?.[i] ?? estimateSWR(hour, monthIdx, cc),
    };
    for (const L of LEVELS) {
      row['t' + L.p]  = hourly['temperature_' + L.p + 'hPa']?.[i];
      row['ws' + L.p] = hourly['wind_speed_' + L.p + 'hPa']?.[i];
      row['wd' + L.p] = hourly['wind_direction_' + L.p + 'hPa']?.[i];
    }
    rows.push(row);
  }
  return rows;
}
const normalizeMulti = json => (Array.isArray(json) ? json : [json]).map(x => x.hourly);
function evaluateSite(hourly, site, tier) {
  const rows = normalizeHourly(hourly);
  const days = {};
  for (const r of rows) (days[r.date] ??= []).push(r);
  return Object.keys(days).sort().slice(0, 3)
    .map(date => ({ date, site, ...scoreDay(days[date], site, tier) }));
}

/* ---------------- exports ---------------- */
const FlyAlarmCore = {
  TIERS, LEVELS,
  DAY_START, DAY_END, FLYABLE_SCORE,
  evaluateSite, scoreDay, evalHour, deriveHour, normalizeHourly, normalizeMulti,
  parsePEFeatures, prepSite,
  haversine, dirAllowed, dirQuality, axisOffset, dirToCompass, meanDir, thermalLabel, clamp,
};
if (typeof module !== 'undefined') module.exports = FlyAlarmCore;
if (typeof window !== 'undefined') window.FlyAlarmCore = FlyAlarmCore;
