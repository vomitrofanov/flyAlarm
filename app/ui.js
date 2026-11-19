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
console.info('FlyAlarm app v1.4');

/* Optional: your own Cloudflare Worker proxy (flyalarm-proxy.js).
   const PE_PROXY = 'https://YOUR-WORKER.workers.dev/?url='; */
const PE_PROXY = '';

const SURFACE_VARS = 'temperature_2m,dew_point_2m,precipitation,precipitation_probability,cloud_cover,wind_speed_10m,wind_direction_10m,wind_gusts_10m,cape,shortwave_radiation';
const PROFILE_VARS = C.LEVELS.map(L => `temperature_${L.p}hPa,wind_speed_${L.p}hPa,wind_direction_${L.p}hPa`).join(',');
const CORE_VARS = 'precipitation,precipitation_probability,cloud_cover,wind_speed_10m,wind_direction_10m,wind_gusts_10m,cape';
const RADII = [25, 50, 100, 200];
const HARD_MAX = 80;        /* absolute safety cap; country mode shows everything below this */
const COUNTRY_MAX = 250;   /* country-wide: show the whole country, coast included */
const PROFILE_TOP = 20;     /* Skew-T profiles fetched for the best N sites */
const CHUNK = 20;

const state = {
  tier: 'standard', dayIdx: 1,
  lat: null, lon: null, cc: null, cityName: null, countryName: null,
  radius: 100,
  sites: [], totalFound: 0, onlineSites: 0, siteVia: null,
  data: {}, fetchedAt: null, busy: false, rerun: false, mode: null, seq: 0,
  view: null,               /* 'watch' = my sites only, 'explore' = everything in radius */
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
      radius: state.radius, tier: state.tier, view: state.view }));
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
    if (s.view === 'watch' || s.view === 'explore') state.view = s.view;
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

/* ---------------- my sites (watchlist) ----------------
   The pilot's own list of launches to monitor. Stored as full site
   records so "My sites" needs no database lookup at all; metadata is
   refreshed from the weekly database whenever the picker opens. */
const WATCH_KEY = 'flyalarm-watch';
const slimSite = s => ({ id: s.id, name: s.name, lat: s.lat, lon: s.lon, alt: s.alt ?? null,
  dirs: s.dirs || [], dirsGood: s.dirsGood || [], tags: s.tags || [],
  country: s.country || '', link: s.link || null });
function loadWatch() {
  try { const a = JSON.parse(localStorage.getItem(WATCH_KEY)); return Array.isArray(a) ? a.filter(s => s && s.id && Number.isFinite(s.lat)) : []; }
  catch (e) { return []; }
}
function saveWatch() { try { localStorage.setItem(WATCH_KEY, JSON.stringify(watch)); } catch (e) {} }
let watch = loadWatch();
const isWatched = id => watch.some(s => s.id === id);
function toggleWatch(site) {
  if (isWatched(site.id)) watch = watch.filter(s => s.id !== site.id);
  else watch.push(slimSite(site));
  saveWatch();
  reflectWatchCount();
}
function reflectWatchCount() {
  const c = $('#watch-count'); if (c) c.textContent = watch.length ? String(watch.length) : '';
}
function shareLink() {
  const ids = watch.filter(s => s.country && /^pe\d+$/.test(s.id))
    .map(s => `${s.country.toUpperCase()}.${s.id.slice(2)}`);
  return `${location.origin}${location.pathname}#w=${ids.join(',')}`;
}
async function importFromHash() {
  const m = location.hash.match(/^#w=([A-Za-z0-9.,]+)/);
  if (!m) return 0;
  const want = m[1].split(',').map(x => x.split('.')).filter(p => p.length === 2 && /^[A-Za-z]{2}$/.test(p[0]));
  const byCC = {};
  for (const [cc, n] of want) (byCC[cc.toUpperCase()] ??= new Set()).add('pe' + n);
  let added = 0;
  for (const [cc, ids] of Object.entries(byCC)) {
    const sites = await loadCountryFile(cc);
    for (const s of sites) if (ids.has(s.id) && !isWatched(s.id)) { watch.push(slimSite(s)); added++; }
  }
  saveWatch();
  try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { location.hash = ''; }
  return added;
}

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
/* The pilot states where they are: country, town, radius.
   No IP lookup. GPS is an optional shortcut that fills the same fields. */
const regionName = (() => {
  let dn = null;
  try { dn = new Intl.DisplayNames(['en'], { type: 'region' }); } catch (e) {}
  return cc => { try { return (dn && dn.of(cc)) || cc; } catch (e) { return cc; } };
})();
function localeCountry() {
  for (const l of (navigator.languages || [navigator.language || ''])) {
    try {
      const loc = new Intl.Locale(l);
      if (loc.language === 'en') continue;   /* English UI says nothing about where the pilot lives */
      const r = loc.maximize().region; if (r) return r.toUpperCase();
    } catch (e) {}
  }
  return null;
}
function ensureCountryOption(cc) {
  const sel = $('#country');
  if (!sel || !cc || [...sel.options].some(o => o.value === cc)) return;
  const o = document.createElement('option'); o.value = cc; o.textContent = regionName(cc);
  sel.appendChild(o);
}
async function loadCountries() {
  const sel = $('#country');
  if (!sel) return;
  let codes = [];
  try {
    const res = await fetchT('../data/index.json', 6000);
    if (res.ok) codes = Object.keys((await res.json()).countries || {});
  } catch (e) {}
  const opts = codes.map(cc => ({ cc, name: regionName(cc) })).sort((a, b) => a.name.localeCompare(b.name));
  sel.innerHTML = '<option value="">Choose…</option>' +
    opts.map(o => `<option value="${o.cc}">${o.name}</option>`).join('');
  if (state.cc) ensureCountryOption(state.cc);
  sel.value = state.cc || '';
}
function setTown(t) {
  state.lat = t.lat; state.lon = t.lon;
  state.cityName = t.name; state.cc = t.cc || state.cc;
  state.countryName = t.country || (state.cc ? regionName(state.cc) : null);
  ensureCountryOption(state.cc);
  saveSettings(); reflectPlace(); hideBanner();
  setStatus(`Around ${state.cityName} — press “Find flyable sites”`);
}
function clearTown() {
  state.lat = null; state.lon = null; state.cityName = null;
  saveSettings(); reflectPlace();
}
function reflectPlace() {
  const ci = $('#city'), co = $('#country');
  if (ci && document.activeElement !== ci) ci.value = state.cityName || '';
  if (co) { if (state.cc) ensureCountryOption(state.cc); co.value = state.cc || ''; }
}

/* ---------- town search (Open-Meteo geocoding) ---------- */
let townResults = [], townActive = -1, townTimer = null, townSeq = 0;
function positionTownList() {
  const ci = $('#city'), ul = $('#city-list');
  if (!ci || !ul || ul.hidden) return;
  const r = ci.getBoundingClientRect();
  ul.style.left = Math.max(8, r.left) + 'px';
  ul.style.top = (r.bottom + 6) + 'px';
  ul.style.width = Math.min(Math.max(r.width, 260), window.innerWidth - 16) + 'px';
}
function closeTownList() {
  const ul = $('#city-list'); if (ul) ul.hidden = true;
  const ci = $('#city'); if (ci) ci.setAttribute('aria-expanded', 'false');
  townActive = -1;
}
function renderTownList(msg) {
  const ul = $('#city-list'), ci = $('#city');
  if (!ul) return;
  ul.innerHTML = msg
    ? `<li class="ce">${msg}</li>`
    : townResults.map((t, i) => `<li role="option" data-i="${i}" class="${i === townActive ? 'active' : ''}" aria-selected="${i === townActive}">
        <span>${t.name}</span><small>${[t.admin, t.cc && t.cc !== state.cc ? regionName(t.cc) : null].filter(Boolean).join(', ')}</small></li>`).join('');
  ul.hidden = false; ci.setAttribute('aria-expanded', 'true');
  positionTownList();
}
async function searchTowns(q) {
  const seq = ++townSeq;
  const url = 'https://geocoding-api.open-meteo.com/v1/search'
    + `?name=${encodeURIComponent(q)}&count=10&language=en&format=json`
    + (state.cc ? `&countryCode=${state.cc}` : '');
  try {
    const j = await (await fetchT(url, 6000)).json();
    if (seq !== townSeq) return;
    const rank = r => (String(r.feature_code || '').startsWith('PPL') ? 0 : 1);
    townResults = (j.results || [])
      .filter(r => Number.isFinite(r.latitude) && Number.isFinite(r.longitude))
      .sort((a, b) => rank(a) - rank(b) || (b.population || 0) - (a.population || 0))
      .slice(0, 8)
      .map(r => ({ name: r.name, lat: r.latitude, lon: r.longitude, admin: r.admin1 || '',
                   cc: (r.country_code || '').toUpperCase(), country: r.country || null }));
    townActive = townResults.length ? 0 : -1;
    renderTownList(townResults.length ? null : 'No town found — check the spelling or the country.');
  } catch (e) {
    if (seq === townSeq) renderTownList('Town search is unavailable right now — try again in a moment.');
  }
}
function pickTown(i) {
  const t = townResults[i];
  if (!t) return;
  closeTownList();
  setTown(t);
  const ci = $('#city'); if (ci) { ci.value = t.name; ci.blur(); }
}

/* ---------- optional GPS shortcut ---------- */
function useMyLocation() {
  if (!navigator.geolocation) { showBanner('GPS is not available in this browser — type your town instead.'); return; }
  setStatus('Locating…');
  navigator.geolocation.getCurrentPosition(
    async pos => {
      const { latitude, longitude, accuracy } = pos.coords;
      if (accuracy > 20000) {
        setStatus('');
        showBanner(`This device could only estimate your position (±${Math.round(accuracy / 1000)} km), so it was not used. Type your town instead.`);
        return;
      }
      const g = await reverseGeocode(latitude, longitude);
      setTown({ lat: latitude, lon: longitude,
        name: (g && g.name) || `${latitude.toFixed(3)}, ${longitude.toFixed(3)}`,
        cc: g && g.cc, country: g && g.country });
      setStatus(`Around ${state.cityName} · GPS ±${Math.round(Math.max(accuracy, 1))} m — press “Find flyable sites”`);
    },
    err => {
      setStatus('');
      showBanner(err.code === 1
        ? 'Location permission is off for this site — type your town instead.'
        : 'Could not get a GPS position — type your town instead.');
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 });
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
const distFrom = s => state.lat != null ? C.haversine(state.lat, state.lon, s.lat, s.lon) : null;
const byDistOrName = (a, b) => (a.dist != null && b.dist != null) ? a.dist - b.dist : a.name.localeCompare(b.name);
function withinParameters(sites) {
  let list = sites.map(s => ({ ...s, dist: distFrom(s) }));
  if (state.radius !== 'country') list = list.filter(s => s.dist <= state.radius);
  list = list.filter(s => !hiddenSites.has(siteKey(s))).sort(byDistOrName);
  state.totalFound = list.length;
  return list.slice(0, state.radius === 'country' ? COUNTRY_MAX : HARD_MAX);
}

function scopeList(sites) {
  let list = sites.map(s => ({ ...s, dist: distFrom(s) }));
  if (state.radius !== 'country') list = list.filter(s => s.dist <= state.radius);
  return list.filter(s => !hiddenSites.has(siteKey(s)) || isWatched(s.id)).sort(byDistOrName);
}
function watchedWithDistance() {
  return watch.map(s => C.prepSite({ ...s,
    dist: state.lat != null ? C.haversine(state.lat, state.lon, s.lat, s.lon) : null }))
    .sort((a, b) => (a.dist ?? 0) - (b.dist ?? 0));
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
      t: Date.now(), view: state.view, sites: state.sites, data: slim,
      stamp: { lat: state.lat, lon: state.lon, radius: state.radius, cc: state.cc } }));
  } catch (e) {}
}
function tryHydrate() {
  try {
    const s = JSON.parse(localStorage.getItem(SNAP_KEY));
    if (!s || Date.now() - s.t > 3 * 3600e3 || !s.sites?.length || (s.view || 'explore') !== state.view) return false;
    state.sites = s.sites.map(C.prepSite);
    state.data = s.data; state.mode = 'live'; state.fetchedAt = new Date(s.t);
    render();
    setStatus('cached \u2014 refreshing\u2026');
    return true;
  } catch (e) { return false; }
}

/* ---------------- search ---------------- */
async function runSearch() {
  if (state.view === 'watch') return runWatch();
  if (state.radius === 'country' && !state.cc) { showBanner('Choose your country first.'); return; }
  if (state.radius !== 'country' && state.lat == null) {
    showBanner(state.cc ? 'Type your town and pick it from the list, then press \u201cFind flyable sites\u201d.'
                        : 'Choose your country and town first.');
    return;
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
async function runWatch() {
  if (state.busy) { state.rerun = true; return; }
  hideBanner();
  if (!watch.length) {
    state.sites = []; state.data = {}; state.mode = null;
    setStatus(''); render(); return;
  }
  state.busy = true;
  const seq = ++state.seq;
  const sites = watchedWithDistance();
  state.sites = sites; state.totalFound = sites.length;
  setStatus(`Fetching forecast for your ${sites.length} site${sites.length > 1 ? 's' : ''}…`);
  try {
    const hourlies = await fetchSurface(sites);
    if (state.rerun || seq !== state.seq) { endBusy(); return; }
    state.data = {};
    sites.forEach((s, i) => { state.data[s.id] = hourlies[i] || { error: true }; });
    state.mode = 'live'; state.fetchedAt = new Date();
    setStatus(''); render(); saveSnapshot();
    fetchProfiles(currentRanking().slice(0, PROFILE_TOP).map(d => d.site), seq);
  } catch (e) {
    state.mode = null; setStatus(''); render();
    showBanner("Couldn't reach the forecast service. Check your connection and press “Refresh my sites”.");
  }
  endBusy();
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
    <p class="note">${site.link ? `<a class="site-act" href="${site.link}" target="_blank" rel="noopener">PE page \u2197</a> ` : ''}<button class="site-act watch-act${isWatched(site.id) ? ' on' : ''}" data-watch="${site.id}">${isWatched(site.id) ? (state.view === 'watch' ? 'remove from my sites' : '\u2605 in my sites') : '\u2606 add to my sites'}</button>${state.view === 'explore' ? ` <button class="site-act" data-hide="${siteKey(site)}">hide site</button>` : ''}</p>
  </article>`;
}

function renderAlert(picked, dates) {
  const el = $('#alert');
  if (!picked.length || !dates.length) { el.hidden = true; return; }
  const label = dayTag(dates[state.dayIdx], state.dayIdx).toLowerCase();
  const scope = state.view === 'watch'
    ? `among your ${state.sites.length} site${state.sites.length > 1 ? 's' : ''}`
    : state.radius === 'country'
      ? `across ${state.countryName || state.cc}` : `within ${state.radius} km of ${state.cityName}`;
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
  document.querySelectorAll('[data-view]').forEach(b =>
    b.classList.toggle('active', b.dataset.view === state.view));
  const sb = $('#search'); if (sb) sb.textContent = state.view === 'watch' ? 'Refresh my sites' : 'Find flyable sites';
  document.body.classList.toggle('view-watch', state.view === 'watch');
  reflectWatchCount();

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

  const hiddenNote = state.view === 'explore' && hiddenSites.size
    ? `<p class="empty">${hiddenSites.size} site${hiddenSites.size > 1 ? 's' : ''} hidden \u00b7 <button class="site-act" id="unhide">show all</button></p>` : '';
  const capNote = state.view === 'explore' && state.totalFound > state.sites.length
    ? `<p class="empty">Showing the nearest ${state.sites.length} of ${state.totalFound} sites.</p>` : '';
  $('#cards').innerHTML = hiddenNote + capNote +
    (picked.map((d, i) => siteCard(d, i + 1)).join('') +
     failed.map(s => `<article class="card v-err"><div class="card-head">
       <div class="titles"><h2>${s.name}</h2><p class="meta">forecast unavailable</p></div></div></article>`).join('')) ||
    (state.view === 'watch' && !watch.length
      ? `<div class="empty-watch"><h3>No sites in your list yet</h3>
          <p>Pick the launches you actually fly. FlyAlarm will then monitor only those, and the alert counts only them.</p>
          <div class="empty-acts"><button class="btn btn-primary" id="empty-pick">Choose my sites</button>
          <button class="btn" data-goto="explore">Browse everything nearby</button></div></div>`
      : '<p class="empty">No data yet. Press \u201cFind flyable sites\u201d.</p>');
  document.querySelectorAll('[data-hide]').forEach(b =>
    b.addEventListener('click', () => hideSite(b.dataset.hide)));
  const un = $('#unhide'); if (un) un.addEventListener('click', unhideAll);
  document.querySelectorAll('[data-watch]').forEach(b => b.addEventListener('click', () => {
    const site = state.sites.find(s => s.id === b.dataset.watch);
    if (!site) return;
    toggleWatch(site);
    if (state.view === 'watch') { state.sites = state.sites.filter(s => s.id !== site.id); saveSnapshot(); }
    render();
  }));
  const ep = $('#empty-pick'); if (ep) ep.addEventListener('click', openPicker);
  document.querySelectorAll('[data-goto]').forEach(b => b.addEventListener('click', () => setView(b.dataset.goto)));

  const dbNote = state.siteVia
    ? `sites: ParaglidingEarth (${state.siteVia})` : 'sites: none';
  const scopeStamp = state.radius === 'country'
    ? `${state.cc} country-wide` : `${state.cityName} (${(state.lat ?? 0).toFixed(2)},${(state.lon ?? 0).toFixed(2)}) r=${state.radius} km`;
  $('#source').textContent = state.mode === 'live' && state.view === 'watch'
    ? `Open-Meteo \u00b7 watching ${state.sites.length} site${state.sites.length > 1 ? 's' : ''} \u00b7 ${String(state.fetchedAt.getHours()).padStart(2,'0')}:${String(state.fetchedAt.getMinutes()).padStart(2,'0')}`
    : state.mode === 'live'
    ? `Open-Meteo \u00b7 ${dbNote} \u00b7 ${state.sites.length} sites \u00b7 ${scopeStamp} \u00b7 ${String(state.fetchedAt.getHours()).padStart(2,'0')}:${String(state.fetchedAt.getMinutes()).padStart(2,'0')}`
    : '';
}

/* ---------------- view switching ---------------- */
function setView(v) {
  if (v === state.view) return;
  state.view = v; saveSettings();
  state.sites = []; state.data = {}; state.mode = null;
  if (!tryHydrate()) render();
  runSearch();
}

/* ---------------- picker: choose my sites ---------------- */
let pickerScope = [], pickerDirty = false;
function pickRow(s) {
  const meta = [
    s.dist != null ? `${Math.round(s.dist)} km` : null,
    s.alt ? `${s.alt} m` : null,
    s.dirs && s.dirs.length ? s.dirs.join(' ') : 'dirs unknown',
    s.country || null,
  ].filter(Boolean).join(' · ');
  return `<label class="pick-row"><input type="checkbox" data-pick="${s.id}"${isWatched(s.id) ? ' checked' : ''}>
    <span class="pick-name">${s.name}</span><span class="pick-meta">${meta}</span></label>`;
}
function renderPicker() {
  const f = ($('#picker-filter').value || '').trim().toLowerCase();
  const match = s => !f || s.name.toLowerCase().includes(f);
  const mine = watchedWithDistance().filter(match);
  const rest = pickerScope.filter(s => !isWatched(s.id) && match(s));
  const scopeLabel = state.radius === 'country'
    ? `All of ${state.countryName || state.cc || 'your country'}`
    : `Within ${state.radius} km of ${state.cityName || 'your location'}`;
  $('#picker-list').innerHTML =
    (mine.length ? `<p class="pick-sec">In my sites (${mine.length})</p>` + mine.map(pickRow).join('') : '') +
    `<p class="pick-sec">${scopeLabel} (${rest.length})</p>` +
    (rest.length ? rest.map(pickRow).join('') : '<p class="pick-empty">Nothing here — widen the radius or clear the filter.</p>');
  $('#picker-count').textContent = `${watch.length} selected`;
}
async function openPicker() {
  const p = $('#picker'); p.hidden = false;
  document.body.classList.add('picker-open');
  $('#picker-list').innerHTML = '<p class="pick-empty">Loading sites…</p>';
  $('#picker-count').textContent = `${watch.length} selected`;
  pickerDirty = false;
  if ((state.radius === 'country' && !state.cc) || (state.radius !== 'country' && state.lat == null)) {
    pickerScope = []; renderPicker();
    $('#picker-list').innerHTML += '<p class="pick-empty">Set your country and town above to see the launches around you.</p>';
    return;
  }
  const all = await fetchSites();
  pickerScope = scopeList(all);
  /* keep watched records fresh with the weekly database */
  let changed = false;
  for (const s of pickerScope) {
    const i = watch.findIndex(w => w.id === s.id);
    if (i >= 0) { const fresh = slimSite(s); if (JSON.stringify(fresh) !== JSON.stringify(watch[i])) { watch[i] = fresh; changed = true; } }
  }
  if (changed) saveWatch();
  renderPicker();
  setTimeout(() => $('#picker-filter').focus(), 50);
}
function closePicker() {
  $('#picker').hidden = true;
  document.body.classList.remove('picker-open');
  if (pickerDirty) {
    if (state.view !== 'watch' && watch.length) setView('watch');
    else if (state.view === 'watch') runSearch();
    else render();
  }
}

/* ---------------- chrome + boot ---------------- */
function setStatus(t) { const el = $('#status'); if (el) el.textContent = t; }
function showBanner(t) { const b = $('#banner'); if (b) { b.textContent = t; b.hidden = false; } }
function hideBanner() { const b = $('#banner'); if (b) b.hidden = true; }
const on = (id, ev, fn) => { const el = $('#' + id); if (el) el.addEventListener(ev, fn); };

document.querySelectorAll('[data-tier]').forEach(b =>
  b.addEventListener('click', () => { state.tier = b.dataset.tier; saveSettings(); render(); }));
on('search', 'click', runSearch);
document.querySelectorAll('[data-view]').forEach(b => b.addEventListener('click', () => setView(b.dataset.view)));
on('manage', 'click', openPicker);
on('picker-close', 'click', closePicker);
on('picker-done', 'click', closePicker);
on('picker-filter', 'input', renderPicker);
on('picker', 'click', e => { if (e.target.id === 'picker') closePicker(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#picker').hidden) closePicker(); });
on('picker-list', 'change', e => {
  const id = e.target.dataset && e.target.dataset.pick;
  if (!id) return;
  const site = pickerScope.find(s => s.id === id) || watch.find(s => s.id === id);
  if (!site) return;
  toggleWatch(site); pickerDirty = true; renderPicker();
});
on('share-list', 'click', async () => {
  const link = shareLink();
  try { await navigator.clipboard.writeText(link); $('#share-list').textContent = 'link copied ✓'; }
  catch (e) { window.prompt('Open this link on your other device:', link); }
  setTimeout(() => { const b = $('#share-list'); if (b) b.textContent = 'copy link to my list'; }, 2500);
});
on('geo', 'click', useMyLocation);
on('country', 'change', () => {
  const cc = $('#country').value || null;
  if (cc === state.cc) return;
  state.cc = cc; state.countryName = cc ? regionName(cc) : null;
  hideBanner();
  clearTown();                                   /* a town belongs to one country */
  if (state.view === 'explore') { state.sites = []; state.data = {}; state.mode = null; render(); }
  if (state.radius === 'country' && cc) setStatus(`${state.countryName} selected \u2014 press \u201cFind flyable sites\u201d`);
  else { setStatus(''); const ci = $('#city'); if (ci && cc) ci.focus(); }
});
on('city', 'input', () => {
  const q = $('#city').value.trim();
  clearTimeout(townTimer);
  if (q.length < 2) { closeTownList(); return; }
  townTimer = setTimeout(() => searchTowns(q), 250);
});
on('city', 'keydown', e => {
  const ul = $('#city-list');
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    if (ul.hidden || !townResults.length) return;
    e.preventDefault();
    townActive = (townActive + (e.key === 'ArrowDown' ? 1 : -1) + townResults.length) % townResults.length;
    renderTownList();
  } else if (e.key === 'Enter') {
    if (!ul.hidden && townActive >= 0) { e.preventDefault(); pickTown(townActive); }
  } else if (e.key === 'Escape') closeTownList();
});
on('city', 'focus', () => { const ci = $('#city'); if (ci.select) ci.select(); });
on('city', 'blur', () => setTimeout(() => {
  closeTownList();
  const ci = $('#city'); if (ci) ci.value = state.cityName || '';   /* only a picked town counts */
}, 180));
on('city-list', 'pointerdown', e => {
  const li = e.target.closest('li[data-i]'); if (!li) return;
  e.preventDefault(); pickTown(+li.dataset.i);
});
on('city-list', 'mousedown', e => e.preventDefault());
window.addEventListener('resize', positionTownList);
window.addEventListener('scroll', positionTownList, { passive: true });
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
  await loadCountries();
  if (!state.cc) {
    const lc = localeCountry();
    if (lc && [...$('#country').options].some(o => o.value === lc)) { state.cc = lc; state.countryName = regionName(lc); }
  }
  reflectPlace();
  const imported = await importFromHash();
  if (imported) state.view = 'watch';
  if (!state.view) state.view = watch.length ? 'watch' : 'explore';
  saveSettings();
  reflectWatchCount();
  if (imported) showBanner(`Imported ${imported} site${imported > 1 ? 's' : ''} into My sites.`);
  const ready = state.view === 'watch' ? watch.length > 0
    : (state.radius === 'country' ? !!state.cc : state.lat != null);
  if (ready) { tryHydrate(); runSearch(); return; }
  render();
  if (state.view === 'explore')
    showBanner(state.cc ? 'Type your town, pick it from the list, choose a radius and press “Find flyable sites”.'
                        : 'Choose your country and town, pick a radius and press “Find flyable sites”.');
})();
