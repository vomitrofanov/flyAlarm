/* ============================================================
   FlyAlarm site-database sync.
   Pulls every country's launches from ParaglidingEarth and
   writes them as static JSON into data/sites/<cc>.json plus a
   data/index.json manifest (counts, timestamps, data-derived
   neighbor countries for cross-border radius searches).
   Run locally: node scripts/sync-sites.mjs
   Runs weekly via .github/workflows/sync-sites.yml
   ============================================================ */
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'fs';

const ISO = ('ad ae af ag ai al am ao ar at au aw az ba bb bd be bf bg bh bi bj bm bn bo br bs bt bw by bz ca cd cf cg ch ci cl cm cn co cr cu cv cy cz de dj dk dm do dz ec ee eg er es et fi fj fk fm fo fr ga gb gd ge gf gh gi gl gm gn gp gq gr gt gu gw gy hk hn hr ht hu id ie il in iq ir is it jm jo jp ke kg kh ki km kn kp kr kw ky kz la lb lc li lk lr ls lt lu lv ly ma mc md me mg mk ml mm mn mo mq mr ms mt mu mv mw mx my mz na nc ne ng ni nl no np nz om pa pe pf pg ph pk pl pm pr pt py qa re ro rs ru rw sa sb sc sd se sg si sk sl sm sn so sr sv sy sz tc td tg th tj tl tm tn to tr tt tw tz ua ug us uy uz vc ve vg vi vn vu ws ye za zm zw').split(' ');

const LETTERS = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];

export function slimFeatures(geojson, cc) {
  const out = [];
  for (const [i, f] of (geojson?.features || []).entries()) {
    const c = f?.geometry?.coordinates;
    if (!c || c.length < 2) continue;
    const p = f.properties || {};
    const val = L => {
      const src = (p.orientations && typeof p.orientations === 'object') ? p.orientations : p;
      const v = src[L] ?? src[L.toLowerCase()];
      return v === 2 || v === '2' ? 2 : (v === 1 || v === '1' || v === true ? 1 : 0);
    };
    const dirs = LETTERS.filter(L => val(L) >= 1);
    const dirsGood = LETTERS.filter(L => val(L) === 2);
    const alt = parseInt(p.takeoff_altitude ?? p.altitude ?? '', 10);
    const tags = ['xc','thermals','soaring','flatland','winch','hike']
      .filter(t => { const v = p[t]; return v === 1 || v === '1' || v === true; });
    const peId = p.pge_site_id ?? p.id ?? null;
    out.push({
      id: 'pe' + (peId ?? cc + i),
      name: p.name || 'Unnamed site',
      lat: +(+c[1]).toFixed(5), lon: +(+c[0]).toFixed(5),
      alt: Number.isFinite(alt) ? alt : null,
      dirs, dirsGood, tags,
      country: cc.toUpperCase(),
      link: peId != null ? 'https://www.paraglidingearth.com/pgearth/index.php?site=' + peId : null,
    });
  }
  return out;
}

export function computeNeighbors(byCC, km = 250) {
  const boxes = {};
  for (const [cc, sites] of Object.entries(byCC)) {
    if (!sites.length) continue;
    boxes[cc] = {
      minLa: Math.min(...sites.map(s => s.lat)), maxLa: Math.max(...sites.map(s => s.lat)),
      minLo: Math.min(...sites.map(s => s.lon)), maxLo: Math.max(...sites.map(s => s.lon)),
    };
  }
  const pad = km / 111;
  const near = (a, b) =>
    a.minLa - pad < b.maxLa && a.maxLa + pad > b.minLa &&
    a.minLo - pad * 1.6 < b.maxLo && a.maxLo + pad * 1.6 > b.minLo;
  const neighbors = {};
  const ccs = Object.keys(boxes);
  for (const a of ccs) neighbors[a] = ccs.filter(b => b !== a && near(boxes[a], boxes[b]));
  return neighbors;
}

async function fetchCountry(cc, base) {
  const url = `${base}/api/geojson/getCountrySites.php?iso=${cc}&style=detailled`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': 'FlyAlarm-sync/1.0 (flyalarm.app)' } });
      if (res.status === 404) return [];
      if (!res.ok) throw new Error('http ' + res.status);
      return slimFeatures(await res.json(), cc);
    } catch (e) {
      await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
  console.error('  ! giving up on', cc);
  return null;                       /* null = keep previous file if any */
}

async function main() {
  const base = process.env.PE_BASE || 'https://www.paraglidingearth.com';
  mkdirSync('data/sites', { recursive: true });
  const byCC = {}, index = { generated: new Date().toISOString(), countries: {}, neighbors: {} };
  let total = 0;
  for (const cc of ISO) {
    const sites = await fetchCountry(cc, base);
    await new Promise(r => setTimeout(r, 700));            /* be polite to PE */
    const file = `data/sites/${cc}.json`;
    if (sites === null) {                                  /* fetch failed: keep old data */
      if (existsSync(file)) {
        const old = JSON.parse(readFileSync(file, 'utf8'));
        byCC[cc.toUpperCase()] = old;
        index.countries[cc.toUpperCase()] = old.length;
        total += old.length;
      }
      continue;
    }
    if (!sites.length) continue;                           /* no launches in this country */
    writeFileSync(file, JSON.stringify(sites));
    byCC[cc.toUpperCase()] = sites;
    index.countries[cc.toUpperCase()] = sites.length;
    total += sites.length;
    console.log(` ${cc.toUpperCase()}: ${sites.length}`);
  }
  index.neighbors = computeNeighbors(byCC);
  index.total = total;
  writeFileSync('data/index.json', JSON.stringify(index));
  console.log(`\nDone: ${total} sites across ${Object.keys(index.countries).length} countries.`);
}
if (process.argv[1] && process.argv[1].endsWith('sync-sites.mjs')) main();
