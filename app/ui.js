/* ============================================================
   FlyAlarm UI v1.1
   No hard-coded geography: sites come exclusively from
   ParaglidingEarth; place & country come from GPS/IP + reverse
   geocoding. Performance: parallel racing with timeouts,
   two-phase weather (surface first, Skew-T profiles after),
   site cache and last-result snapshot for instant paints.
   ============================================================ */
const C = window.FlyAlarmCore;
const $ = sel => document.querySelector(sel);
console.info('FlyAlarm app v1.2');

/* Optional: your own Cloudflare Worker proxy (flyalarm-proxy.js).
   const PE_PROXY = 'https://YOUR-WORKER.workers.dev/?url='; */
const PE_PROXY = '';

const SURFACE_VARS = 'temperature_2m,dew_point_2m,precipitation,precipitation_probability,cloud_cover,wind_speed_10m,wind_direction_10m,wind_gusts_10m,cape,shortwave_radiation';
const PROFILE_VARS = C.LEVELS.map(L => `temperature_${L.p}hPa,wind_speed_${L.p}hPa,wind_direction_${L.p}hPa`).join(',');
const CORE_VARS = 'precipitation,precipitation_probability,cloud_cover,wind_speed_10m,wind_direction_10m,wind_gusts_10m,cape';
const RADII = [25, 50, 100, 200];
const HARD_MAX = 80;        /* absolute safety cap; country mode shows everything below this */
const PROFILE_TOP = 20;     /* Skew-T profiles fetched for the best N sites */
const CHUNK = 20;

const state = {
  tier: 'standard', dayIdx: 1,
  lat: null, lon: null, cc: null, cityName: null, countryName: null,
  radius: 100,
  sites: [], totalFound: 0, onlineSites: 0, siteVia: null,
  data: {}, fetchedAt: null, busy: false, rerun: false, mode: null, seq: 0,
};

/* ---------------- fetch helpers ---------------- */
function fetchT(url, ms = 8000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  return fetch(url, { signal: c.signal }).finally(() => clearTimeout(t));
}
async function firstJSON(attempts, validate) {
  return Promise.any(attempts.map(async a => {
    const res = await fetchT(a.url, a.timeout || 7000);
    if (!res.ok) throw new Error('http ' + res.status);
    const v = validate(await res.json());
    if (!v) throw new Error('invalid');
    return { value: v, via: a.via };
  }));
}

/* ---------------- persistence ---------------- */
const SETTINGS_KEY = 'flyalarm-settings';
function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({
      lat: state.lat, lon: state.lon, cc: state.cc,
      cityName: state.cityName, countryName: state.countryName,
      radius: state.radius, tier: state.tier }));
  } catch (e) {}
}
function restoreSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY));
    if (!s) return false;
    if (Number.isFinite(s.lat) && Number.isFinite(s.lon)) { state.lat = s.lat; state.lon = s.lon; }
    if (typeof s.cc === 'string' && s.cc.length === 2) state.cc = s.cc;
    if (typeof s.cityName === 'string') state.cityName = s.cityName;
    if (typeof s.countryName === 'string') state.countryName = s.countryName;
    if (RADII.includes(s.radius) || s.radius === 'country') state.radius = s.radius;
    if (C.TIERS[s.tier]) state.tier = s.tier;
    return Number.isFinite(state.lat);
  } catch (e) { return false; }
}
const HIDDEN_KEY = 'flyalarm-hidden-sites';
const siteKey = s => s.id + '|' + s.lat.toFixed(3) + ',' + s.lon.toFixed(3);
function loadHidden() { try { return new Set(JSON.parse(localStorage.getItem(HIDDEN_KEY)) || []); } catch (e) { return new Set(); } }
function saveHidden(set) { try { localStorage.setItem(HIDDEN_KEY, JSON.stringify([...set])); } catch (e) {} }
let hiddenSites = loadHidden();
function hideSite(key) { hiddenSites.add(key); saveHidden(hiddenSites); render(); }
function unhideAll() { hiddenSites = new Set(); saveHidden(hiddenSites); render(); }

/* ---------------- location: GPS-first, reverse-geocoded ---------------- */
async function reverseGeocode(lat, lon) {
  try {
    const j = await (await fetchT(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=en`, 6000)).json();
    const cc = (j.countryCode || '').toUpperCase();
    if (cc) return { name: j.city || j.locality || j.principalSubdivision || null,
                     cc, country: j.countryName || null };
  } catch (e) {}
  try {
    const j = await (await fetchT(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=10&accept-language=en`, 6000)).json();
    const ad = j.address || {};
    const cc = (ad.country_code || '').toUpperCase();
    if (cc) return { name: ad.city || ad.town || ad.village || ad.municipality || ad.county || j.name || null,
                     cc, country: ad.country || null };
  } catch (e) {}
  return null;
}
async function ipLocate() {
  try {
    const j = await (await fetchT('https://ipwho.is/', 6000)).json();
    if (Number.isFinite(j.latitude)) return { lat: j.latitude, lon: j.longitude,
      name: j.city || null, cc: (j.country_code || '').toUpperCase() || null, country: j.country || null };
  } catch (e) {}
  try {
    const j = await (await fetchT('https://ipapi.co/json/', 6000)).json();
    if (Number.isFinite(j.latitude)) return { lat: j.latitude, lon: j.longitude,
      name: j.city || null, cc: (j.country_code || '').toUpperCase() || null, country: j.country_name || null };
  } catch (e) {}
  return null;
}
async function setPlace(lat, lon, known) {
  state.lat = lat; state.lon = lon;
  const g = known && known.cc ? known : await reverseGeocode(lat, lon);
  state.cityName = (g && g.name) || `${lat.toFixed(2)}, ${lon.toFixed(2)}`;
  state.cc = (g && g.cc) || null;
  state.countryName = (g && g.country) || null;
  saveSettings();
  reflectPlace();
}
function reflectPlace() {
  const an = $('#around-name'), li = $('#lat'), lo = $('#lon');
  if (an) an.textContent = state.cityName || '\u2014';
  if (li) li.value = state.lat != null ? state.lat.toFixed(3) : '';
  if (lo) lo.value = state.lon != null ? state.lon.toFixed(3) : '';
}
function useMyLocation() {
  const done = note => { setStatus(`Around set to ${state.cityName}${note ? ' \u00b7 ' + note : ''}`); hideBanner(); };
  const netFallback = async why => {
    setStatus('Locating by network\u2026');
    const ip = await ipLocate();
    if (ip) { await setPlace(ip.lat, ip.lon, ip); done('network location \u2014 approximate; on a phone GPS is exact'); }
    else { setStatus(''); showBanner(why + ' Network location also failed \u2014 keeping the previous setting.'); }
  };
  if (!navigator.geolocation) { netFallback('This browser has no geolocation.'); return; }
  setStatus('Locating\u2026');
  navigator.geolocation.getCurrentPosition(
    async pos => {
      const { latitude, longitude, accuracy } = pos.coords;
      await setPlace(latitude, longitude);
      done(accuracy >= 1000 ? `\u00b1${Math.round(accuracy / 1000)} km` : `\u00b1${Math.round(Math.max(accuracy, 1))} m`);
      if (accuracy > 20000) showBanner(`This fix is IP-grade (\u00b1${Math.round(accuracy / 1000)} km) \u2014 typical for desktops without GPS. On a phone this button is exact.`);
    },
    err => netFallback(err.code === 1 ? 'Location permission is denied for this site.'
      : err.code === 3 ? 'Location request timed out.' : 'Location unavailable on this device.'),
    { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 });
}

/* ---------------- sites: ParaglidingEarth only ---------------- */
const SITECACHE_PREFIX = 'flyalarm-sites:';
const SITECACHE_TTL = 12 * 3600e3;
function siteQuery() {
  return state.radius === 'country'
    ? `https://www.paraglidingearth.com/api/geojson/getCountrySites.php?iso=${(state.cc || '').toLowerCase()}&style=detailled`
    : `https://www.paraglidingearth.com/api/geojson/getAroundLatLngSites.php?lat=${state.lat}&lng=${state.lon}&distance=${state.radius}&limit=150&style=detailled`;
}
function cacheKey() {
  return SITECACHE_PREFIX + (state.radius === 'country'
    ? 'cc:' + state.cc
    : `r${state.radius}:${state.lat.toFixed(2)},${state.lon.toFixed(2)}`);
}
/* Static database: the repo's own mirror of ParaglidingEarth,
   refreshed weekly by GitHub Actions (scripts/sync-sites.mjs).
   Same-origin, instant, no proxies. Live API remains the fallback. */
let dbIndex;
async function loadDbIndex() {
  if (dbIndex !== undefined) return dbIndex;
  try {
    const res = await fetchT('../data/index.json', 5000);
    dbIndex = res.ok ? await res.json() : null;
    if (dbIndex && Date.now() - Date.parse(dbIndex.generated) > 21 * 86400e3) dbIndex = null; /* stale */
  } catch (e) { dbIndex = null; }
  return dbIndex;
}
async function loadCountryFile(cc) {
  try {
    const res = await fetchT(`../data/sites/${cc.toLowerCase()}.json`, 6000);
    return res.ok ? await res.json() : [];
  } catch (e) { return []; }
}
async function fetchFromStaticDb() {
  const idx = await loadDbIndex();
  if (!idx || !state.cc) return null;
  const cc = state.cc.toUpperCase();
  if (state.radius === 'country') {
    if (!idx.countries[cc]) return null;
    const sites = await loadCountryFile(cc);
    return sites.length ? sites.map(C.prepSite) : null;
  }
  const ccs = [cc, ...(idx.neighbors?.[cc] || [])].filter(c => idx.countries[c]);
  if (!ccs.length) return null;
  const parts = await Promise.all(ccs.map(loadCountryFile));
  const sites = parts.flat();
  return sites.length ? sites.map(C.prepSite) : null;
}

async function fetchSites() {
  const local = await fetchFromStaticDb();
  if (local) { state.siteVia = 'local db'; return local; }
  try {
    const c = JSON.parse(localStorage.getItem(cacheKey()));
    if (c && Date.now() - c.t < SITECACHE_TTL && Array.isArray(c.sites) && c.sites.length) {
      state.siteVia = 'cache';
      return c.sites.map(C.prepSite);
    }
  } catch (e) {}
  const q = siteQuery(), enc = encodeURIComponent(q);
  const attempts = [];
  if (PE_PROXY) attempts.push({ url: PE_PROXY + enc, via: 'your proxy' });
  attempts.push({ url: q, via: 'direct' });
  attempts.push({ url: 'https://corsproxy.io/?url=' + enc, via: 'public proxy' });
  attempts.push({ url: 'https://api.allorigins.win/raw?url=' + enc, via: 'public proxy' });
  try {
    const { value, via } = await firstJSON(attempts,
      j => { const s = C.parsePEFeatures(j); return s.length ? s : null; });
    state.siteVia = via;
    try { localStorage.setItem(cacheKey(), JSON.stringify({ t: Date.now(), sites: value })); } catch (e) {}
    return value;
  } catch (e) { state.siteVia = null; return []; }
}
function withinParameters(sites) {
  let list = sites.map(s => ({ ...s, dist: C.haversine(state.lat, state.lon, s.lat, s.lon) }));
  if (state.radius !== 'country') list = list.filter(s => s.dist <= state.radius);
  list = list.filter(s => !hiddenSites.has(siteKey(s))).sort((a, b) => a.dist - b.dist);
  state.totalFound = list.length;
  return list.slice(0, HARD_MAX);
}

/* ---------------- weather: two-phase ---------------- */
function batchUrl(sites, vars) {
  return 'https://api.open-meteo.com/v1/forecast'
    + `?latitude=${sites.map(s => s.lat.toFixed(3)).join(',')}`
    + `&longitude=${sites.map(s => s.lon.toFixed(3)).join(',')}`
    + '&timezone=auto&forecast_days=3&wind_speed_unit=kmh'
    + `&hourly=${vars}`;
}
const chunks = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));
async function fetchChunk(sitesChunk, varSets) {
  for (const vars of varSets) {
    try {
      const res = await fetchT(batchUrl(sitesChunk, vars), 14000);
      if (!res.ok) continue;
      const hourlies = C.normalizeMulti(await res.json());
      if (hourlies.length === sitesChunk.length && hourlies[0]?.time) return hourlies;
    } catch (e) {}
  }
  return sitesChunk.map(() => null);
}
async function fetchSurface(sites) {
  const parts = await Promise.all(chunks(sites, CHUNK).map(ch => fetchChunk(ch, [SURFACE_VARS, CORE_VARS])));
  return parts.flat();
}
async function fetchProfiles(sites, seq) {
  if (!sites.length) return;
  const parts = await Promise.all(chunks(sites, CHUNK).map(ch => fetchChunk(ch, [PROFILE_VARS])));
  if (seq !== state.seq) return;
  const flat = parts.flat();
  sites.forEach((s, i) => {
    const prof = flat[i], base = state.data[s.id];
    if (!prof || !base || base.error || !base.time || prof.time?.[0] !== base.time[0]) return;
    Object.assign(base, prof);
  });
  render();
  setStatus('Skew\u2011T profiles loaded');
  setTimeout(() => { if (seq === state.seq) setStatus(''); }, 2500);
}

/* ---------------- snapshot: instant paint on return visits ---------------- */
const SNAP_KEY = 'flyalarm-last';
function saveSnapshot() {
  try {
    const slim = {};
    for (const [id, h] of Object.entries(state.data)) {
      if (!h || h.error) continue;
      const o = {};
      for (const [k, v] of Object.entries(h)) if (!k.includes('hPa')) o[k] = v;
      slim[id] = o;
    }
    localStorage.setItem(SNAP_KEY, JSON.stringify({
      t: Date.now(), sites: state.sites, data: slim,
      stamp: { lat: state.lat, lon: state.lon, radius: state.radius, cc: state.cc } }));
  } catch (e) {}
}
function tryHydrate() {
  try {
    const s = JSON.parse(localStorage.getItem(SNAP_KEY));
    if (!s || Date.now() - s.t > 3 * 3600e3 || !s.sites?.length) return false;
    state.sites = s.sites.map(C.prepSite);
    state.data = s.data; state.mode = 'live'; state.fetchedAt = new Date(s.t);
    render();
    setStatus('cached \u2014 refreshing\u2026');
    return true;
  } catch (e) { return false; }
}

/* ---------------- search ---------------- */
async function runSearch() {
  if (state.lat == null) { showBanner('Set your location first \u2014 press \u201cUse my location\u201d.'); return; }
  if (state.radius === 'country' && !state.cc) {
    showBanner('Couldn\u2019t detect your country yet \u2014 press \u201cUse my location\u201d again or pick a km radius.'); return;
  }
  if (state.busy) { state.rerun = true; return; }
  state.busy = true;
  const seq = ++state.seq;
  setStatus('Finding sites\u2026');
  hideBanner();
  try {
    const found = withinParameters(await fetchSites());
    if (state.rerun || seq !== state.seq) { endBusy(); return; }
    state.sites = found;
    if (!found.length) {
      state.mode = null; state.data = {};
      setStatus(''); render();
      showBanner(state.siteVia === null
        ? 'Site database (ParaglidingEarth) unreachable right now \u2014 no sites shown rather than made-up ones. Retry in a minute, or deploy your proxy (flyalarm-proxy.js) for a reliable channel.'
        : state.radius === 'country'
          ? `ParaglidingEarth lists no launches for ${state.countryName || state.cc}.`
          : `No known launches within ${state.radius} km of ${state.cityName}. Widen the radius.`);
      endBusy(); return;
    }
    setStatus(`Fetching forecast for ${found.length} sites\u2026`);
    const hourlies = await fetchSurface(found);
    if (state.rerun || seq !== state.seq) { endBusy(); return; }
    state.data = {};
    found.forEach((s, i) => { state.data[s.id] = hourlies[i] || { error: true }; });
    state.mode = 'live';
    state.fetchedAt = new Date();
    setStatus('');
    render();
    saveSnapshot();
    const top = currentRanking().slice(0, PROFILE_TOP).map(d => d.site);
    fetchProfiles(top, seq);
  } catch (e) {
    state.mode = null;
    setStatus(''); render();
    showBanner("Couldn't reach the forecast service from this view. If you're previewing inside Claude, download the files and open them in your browser.");
  }
  endBusy();
}
function endBusy() {
  state.busy = false;
  if (state.rerun) { state.rerun = false; runSearch(); }
}

/* ---------------- SVG builders ---------------- */
const polar = (cx, cy, r, deg) => {
  const a = (deg - 90) * Math.PI / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
};
function compassSVG(site, windDir, inSector) {
  const S = 62, c = S / 2, r = 24;
  let p = `<svg class="compass" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}" aria-hidden="true">`;
  p += `<circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="var(--line)" stroke-width="1.5"${site.sectorUnknown ? ' stroke-dasharray="3 3"' : ''}/>`;
  for (let d = 0; d < 360; d += 45) {
    const [x1, y1] = polar(c, c, r, d), [x2, y2] = polar(c, c, r - 3.5, d);
    p += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="var(--faint)" stroke-width="1"/>`;
  }
  if (site.sectorUnknown) p += `<text x="${c}" y="${c + 4}" text-anchor="middle" class="cmp-q">?</text>`;
  else for (const cd of site._degsW) {
    const [x1, y1] = polar(c, c, r, cd.deg - 25), [x2, y2] = polar(c, c, r, cd.deg + 25);
    p += `<path d="M ${c} ${c} L ${x1} ${y1} A ${r} ${r} 0 0 1 ${x2} ${y2} Z" fill="var(--accent)" opacity="${cd.w === 1 ? '0.30' : '0.13'}"/>`;
  }
  if (windDir != null) {
    const col = inSector === false ? 'var(--bad)' : 'var(--good)';
    const [ax, ay] = polar(c, c, r - 2, windDir), [bx, by] = polar(c, c, 7, windDir);
    const [h1x, h1y] = polar(bx, by, 5.5, windDir + 150), [h2x, h2y] = polar(bx, by, 5.5, windDir - 150);
    p += `<line x1="${ax}" y1="${ay}" x2="${bx}" y2="${by}" stroke="${col}" stroke-width="2.2" stroke-linecap="round"/>`;
    p += `<path d="M ${bx} ${by} L ${h1x} ${h1y} L ${h2x} ${h2y} Z" fill="${col}"/>`;
  }
  const [nx, ny] = polar(c, c, r + 6.5, 0);
  p += `<text x="${nx}" y="${ny + 3}" text-anchor="middle" class="cmp-n">N</text></svg>`;
  return p;
}
function gaugeSVG(score) {
  const S = 58, c = S / 2, r = 24, circ = 2 * Math.PI * r;
  const frac = Math.max(0.02, score / 10);
  return `<svg class="gauge" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}" aria-hidden="true">
    <circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="var(--line)" stroke-width="4.5"/>
    <circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="currentColor" stroke-width="4.5"
      stroke-linecap="round" stroke-dasharray="${(circ * frac).toFixed(1)} ${circ.toFixed(1)}"
      transform="rotate(-90 ${c} ${c})"/>
    <text x="${c}" y="${c + 5.5}" text-anchor="middle" class="g-num">${score}</text></svg>`;
}

/* ---------------- rendering ---------------- */
const WD = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const dayTag = (iso, idx) => idx === 0 ? 'Today' : idx === 1 ? 'Tomorrow' : WD[new Date(iso + 'T12:00').getDay()];
const fmtDay = (iso, idx) => {
  const d = new Date(iso + 'T12:00');
  return `${dayTag(iso, idx)}<span class="tab-date">${String(d.getDate()).padStart(2,'0')}.${String(d.getMonth()+1).padStart(2,'0')}</span>`;
};
const GATE_SHORT = {
  storm: 'storm risk', rain: 'rain', cape: 'OD risk', wind: 'wind over limit',
  gust: 'gusts over limit', gustspread: 'gust spread', aloftwind: 'wind aloft over limit',
  direction: 'out of sector', strongthermals: 'strong for profile',
};
const hourTooltip = h =>
  h.state === 'gated' ? `${h.hour}:00 \u2014 ${h.gates.map(g => GATE_SHORT[g]).join(', ')}` :
  h.state === 'soft'  ? `${h.hour}:00 \u2014 thermals too strong for this profile` :
  `${h.hour}:00 \u2014 flyable (quality ${(h.q * 10).toFixed(0)}/10, ${C.thermalLabel(h.idx)} thermals)`;
const verdictClass = s =>
  s === 0 ? 'v-nofly' : s <= 3 ? 'v-poor' : s <= 5 ? 'v-marg' : s <= 7 ? 'v-good' : 'v-top';

function evaluateAll(tier) {
  const evaluated = [], failed = [];
  for (const site of state.sites) {
    const d = state.data[site.id];
    if (!d || d.error) { if (d && d.error) failed.push(site); continue; }
    const days = C.evaluateSite(d, site, tier);
    if (days.length) evaluated.push(days);
  }
  return { evaluated, failed };
}
function currentRanking() {
  const { evaluated } = evaluateAll(C.TIERS[state.tier]);
  return evaluated
    .map(days => days[Math.min(state.dayIdx, days.length - 1)])
    .sort((a, b) => b.score - a.score || b.window.len - a.window.len);
}

function siteCard(day, rank) {
  const site = day.site;
  const nH = C.DAY_END - C.DAY_START + 1;
  const winHours = day.hours.filter(x => x.state === 'good' || x.state === 'ok');
  const dirPool = (winHours.length ? winHours : day.hours).map(x => x.raw.dir);
  const meanW = dirPool.length ? C.meanDir(dirPool) : null;
  const inSector = site.sectorUnknown || meanW == null ? null : C.dirAllowed(meanW, site._degs);
  const cells = day.hours.map(h => `<div class="cell c-${h.state}" title="${hourTooltip(h)}"></div>`).join('');
  const bracket = day.window.len
    ? `<div class="bracket" style="left:${(day.window.from - C.DAY_START) / nH * 100}%;width:${day.window.len / nH * 100}%">
         <span>${day.window.from}\u2013${day.window.to + 1} h</span></div>` : '';
  const reasons = day.reasons.map(r =>
    `<li class="${r.startsWith('\u26a1') || r.startsWith('\u26a0') ? 'r-storm' : ''}">${r}</li>`).join('');
  const s = day.stats;
  const TAG_LABEL = { xc:'XC', thermals:'thermals', soaring:'soaring', flatland:'flatland', winch:'winch', hike:'hike&fly' };
  const tagChips = (site.tags || []).map(t => `<span class="chip chip-tag">${TAG_LABEL[t] || t}</span>`).join('')
    + (site.country ? `<span class="chip chip-tag">${site.country}</span>` : '');
  const meta = [
    site.dist != null ? `${Math.round(site.dist)} km away` : null,
    site.alt ? `${site.alt} m` : null,
    site.sectorUnknown ? 'takeoff dirs unknown' : `takeoff ${site.dirs.join(' ')}`,
  ].filter(Boolean).join(' \u00b7 ');
  const profBits = [
    s.baseTyp != null ? `base ~${s.baseTyp} m` : null,
    s.topMax != null ? `tops ~${s.topMax} m` : null,
    s.aloftMax ? `@launch \u2264${s.aloftMax} km/h` : null,
  ].filter(Boolean).join(' \u00b7 ');
  return `<article class="card ${verdictClass(day.score)}">
    <div class="card-head">
      ${compassSVG(site, meanW, inSector)}
      <div class="titles">
        <div class="rankline"><span class="rank">#${rank}</span>${tagChips}</div>
        <h2>${site.name}</h2>
        <p class="meta">${meta}</p>
      </div>
      <div class="score">${gaugeSVG(day.score)}<div class="verdict">${day.verdict}</div></div>
    </div>
    <div class="strip-wrap">${bracket}<div class="strip">${cells}</div>
      <div class="ticks"><span>8</span><span>12</span><span>16</span><span>20</span></div></div>
    <ul class="reasons">${reasons || '<li>No usable window for this profile.</li>'}</ul>
    <p class="stats">wind ${s.windMin}\u2013${s.windMaxSeen} km/h \u00b7 gusts \u2264${s.gustMax}${profBits ? ' \u00b7 ' + profBits : ''} \u00b7 CAPE \u2264${s.capeMax} \u00b7 thermals ${C.thermalLabel(s.thermalPeak)}</p>
    <p class="note">${site.link ? `<a class="site-act" href="${site.link}" target="_blank" rel="noopener">PE page \u2197</a> ` : ''}<button class="site-act" data-hide="${siteKey(site)}">hide site</button></p>
  </article>`;
}

function renderAlert(picked, dates) {
  const el = $('#alert');
  if (!picked.length || !dates.length) { el.hidden = true; return; }
  const label = dayTag(dates[state.dayIdx], state.dayIdx).toLowerCase();
  const scope = state.radius === 'country'
    ? `across ${state.countryName || state.cc}` : `within ${state.radius} km`;
  const flyable = picked.filter(d => d.score >= C.FLYABLE_SCORE);
  const best = picked[0];
  el.hidden = false;
  if (flyable.length) {
    el.className = 'a-good';
    const w = best.window;
    el.innerHTML = `<span class="a-ico">\u25c9</span><div><b>${flyable.length} site${flyable.length > 1 ? 's' : ''} flyable ${label}</b> ${scope}<br>
      <span class="a-sub">Best: <b>${best.site.name}</b> \u2014 ${best.score}/10, window ${w.from}\u2013${w.to + 1} h</span></div>`;
  } else if (best && best.score >= 4) {
    el.className = 'a-mid';
    el.innerHTML = `<span class="a-ico">\u25d1</span><div><b>Marginal only ${label}.</b><br>
      <span class="a-sub">Best is ${best.site.name} (${best.score}/10${best.site.sectorUnknown ? ', directions unverified' : ''}) \u2014 nothing worth an alarm.</span></div>`;
  } else {
    el.className = 'a-none';
    el.innerHTML = `<span class="a-ico">\u25cb</span><div><b>No flyable sites ${label}</b> ${scope}.</div>`;
  }
}

function render() {
  const tier = C.TIERS[state.tier];
  document.querySelectorAll('[data-tier]').forEach(b =>
    b.classList.toggle('active', b.dataset.tier === state.tier));
  const tb = $('#tier-blurb'); if (tb) tb.textContent = tier.blurb;

  const { evaluated, failed } = evaluateAll(tier);
  const tabs = $('#day-tabs');
  let dates = [];
  if (evaluated.length) {
    dates = evaluated[0].map(x => x.date);
    state.dayIdx = Math.min(state.dayIdx, dates.length - 1);
    tabs.innerHTML = dates.map((dt, i) =>
      `<button class="tab ${i === state.dayIdx ? 'active' : ''}" data-day="${i}">${fmtDay(dt, i)}</button>`).join('');
    tabs.querySelectorAll('[data-day]').forEach(b =>
      b.addEventListener('click', () => { state.dayIdx = +b.dataset.day; render(); }));
  } else tabs.innerHTML = '';

  const picked = evaluated
    .map(days => days[Math.min(state.dayIdx, days.length - 1)])
    .sort((a, b) => b.score - a.score || b.window.len - a.window.len);
  renderAlert(picked, dates);

  const hiddenNote = hiddenSites.size
    ? `<p class="empty">${hiddenSites.size} site${hiddenSites.size > 1 ? 's' : ''} hidden \u00b7 <button class="site-act" id="unhide">show all</button></p>` : '';
  const capNote = state.totalFound > state.sites.length
    ? `<p class="empty">Showing the nearest ${state.sites.length} of ${state.totalFound} sites.</p>` : '';
  $('#cards').innerHTML = hiddenNote + capNote +
    (picked.map((d, i) => siteCard(d, i + 1)).join('') +
     failed.map(s => `<article class="card v-err"><div class="card-head">
       <div class="titles"><h2>${s.name}</h2><p class="meta">forecast unavailable</p></div></div></article>`).join('')) ||
    '<p class="empty">No data yet. Press \u201cFind flyable sites\u201d.</p>';
  document.querySelectorAll('[data-hide]').forEach(b =>
    b.addEventListener('click', () => hideSite(b.dataset.hide)));
  const un = $('#unhide'); if (un) un.addEventListener('click', unhideAll);

  const dbNote = state.siteVia
    ? `sites: ParaglidingEarth (${state.siteVia})` : 'sites: none';
  const scopeStamp = state.radius === 'country'
    ? `${state.cc} country-wide` : `${(state.lat ?? 0).toFixed(2)},${(state.lon ?? 0).toFixed(2)} r=${state.radius} km`;
  $('#source').textContent = state.mode === 'live'
    ? `Open-Meteo \u00b7 ${dbNote} \u00b7 ${state.sites.length} sites \u00b7 ${scopeStamp} \u00b7 ${String(state.fetchedAt.getHours()).padStart(2,'0')}:${String(state.fetchedAt.getMinutes()).padStart(2,'0')}`
    : '';
}

/* ---------------- chrome + boot ---------------- */
function setStatus(t) { const el = $('#status'); if (el) el.textContent = t; }
function showBanner(t) { const b = $('#banner'); if (b) { b.textContent = t; b.hidden = false; } }
function hideBanner() { const b = $('#banner'); if (b) b.hidden = true; }
const on = (id, ev, fn) => { const el = $('#' + id); if (el) el.addEventListener(ev, fn); };

document.querySelectorAll('[data-tier]').forEach(b =>
  b.addEventListener('click', () => { state.tier = b.dataset.tier; saveSettings(); render(); }));
on('search', 'click', runSearch);
on('geo', 'click', useMyLocation);
on('radius', 'change', () => {
  const v = $('#radius').value;
  state.radius = v === 'country' ? 'country' : parseInt(v, 10);
  saveSettings();
});
const tl = $('#today-line');
if (tl) tl.textContent = new Date().toLocaleDateString('en-GB',
  { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

(async function boot() {
  const had = restoreSettings();
  $('#radius').value = String(state.radius);
  reflectPlace();
  if (had) { tryHydrate(); runSearch(); return; }
  /* first visit: silent IP location (no permission prompt), then search */
  setStatus('Locating by network\u2026');
  const ip = await ipLocate();
  if (ip) { await setPlace(ip.lat, ip.lon, ip); setStatus(''); runSearch(); }
  else { setStatus(''); showBanner('Press \u201cUse my location\u201d to begin.'); }
})();
