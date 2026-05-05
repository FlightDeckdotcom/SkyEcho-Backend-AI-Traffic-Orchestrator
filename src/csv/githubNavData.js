const { parse } = require('csv-parse/sync');
const { loadCsv } = require('./csvLoader');
const path = require('path');

const DEFAULT_NAVDATA_BASE_URL = 'https://raw.githubusercontent.com/FlightDeckdotcom/SKYECHOCABIN-Discord-Bot/main/data';

// Full catalog from your SKYECHOCABIN-Discord-Bot/data folder. v1.2 does NOT load all of this at boot.
const FILES = [
  'airports.csv','runways.csv','airport-frequencies.csv','airport-comments.csv','countries.csv','regions.csv','navaids.csv',
  'Airspace_Boundary.csv','EnrouteInformationPending.csv','FrequencyPending.csv','Pending_AM_Apron.csv','Pending_AM_Special_Movement.csv','Pending_AM_Stopway.csv','Pending_AM_Taxiway.csv','Pending_ATS_Route.csv','Pending_Changeover_Point.csv','Pending_Class_Airspace.csv','Pending_Designated_Point.csv','Pending_Holding_Pattern.csv','Pending_ILS_Component.csv','Pending_ILS_System.csv','Pending_NAVAID_Component.csv','Pending_NAVAID_System.csv','Pending_Radial_Bearing_.csv','Pending_Route_Airspace.csv','RoutePortionPending.csv'
];

// Safe subset to load first. The big Pending_* files can be synced later on demand.
const BOOT_FILES = ['airports.csv','runways.csv','airport-frequencies.csv','navaids.csv','Pending_AM_Taxiway.csv','Pending_AM_Apron.csv','Pending_ATS_Route.csv','Pending_Designated_Point.csv'];

function first(row, keys, fallback='') {
  for (const k of keys) if (row && row[k] !== undefined && row[k] !== '') return row[k];
  return fallback;
}

async function fetchTextWithLimit(url, { timeoutMs=12000, maxBytes=6_000_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { 'user-agent': 'SkyEchoBackend/1.2' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error(`file too large > ${maxBytes} bytes`);
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    clearTimeout(timer);
  }
}

function parseCsvText(text) {
  return parse(text, { columns: true, skip_empty_lines: true, relax_column_count: true, bom: true });
}

async function tryLoadRemote(baseUrl, filename, opts={}) {
  const url = `${String(baseUrl).replace(/\/+$/,'')}/${encodeURIComponent(filename).replace(/%2F/g,'/')}`;
  try {
    const text = await fetchTextWithLimit(url, opts);
    return { ok:true, filename, rows: parseCsvText(text), url, bytes: Buffer.byteLength(text) };
  } catch (e) {
    return { ok:false, filename, rows: [], error:e.message, url };
  }
}
function tryLoadLocal(dataDir, filename) {
  try { return { ok:true, filename, rows: loadCsv(path.join(dataDir, filename)), local:true }; }
  catch (e) { return { ok:false, filename, rows: [], error:e.message, local:true }; }
}

async function loadNavData({ dataDir, baseUrl, preferRemote=false, files=BOOT_FILES, timeoutMs=12000, maxBytes=6_000_000 }) {
  const out = { source: preferRemote ? 'remote-limited' : 'local', baseUrl, files:{}, counts:{}, errors:[], loadedFiles:[] };
  for (const f of files) {
    let r = preferRemote && baseUrl ? await tryLoadRemote(baseUrl, f, { timeoutMs, maxBytes }) : tryLoadLocal(dataDir, f);
    if (!r.ok) {
      const local = tryLoadLocal(dataDir, f);
      if (local.ok) r = local;
    }
    out.files[f] = r.rows;
    out.counts[f] = r.rows.length;
    if (r.ok) out.loadedFiles.push(f);
    if (!r.ok) out.errors.push({ filename:f, error:r.error });
  }
  return out;
}

function normalizeAirportRows(nav) {
  const rows = [];
  const airports = nav.files['airports.csv'] || [];
  const runways = nav.files['runways.csv'] || [];
  const taxiways = nav.files['Pending_AM_Taxiway.csv'] || [];
  const aprons = nav.files['Pending_AM_Apron.csv'] || [];
  for (const a of airports) {
    const icao = String(first(a, ['ident','icao','airport_icao','gps_code','local_code'], '')).toUpperCase();
    if (!icao) continue;
    rows.push({ airport_icao:icao, type:'airport', id:icao, name:first(a,['name','airport_name'],icao), lat:first(a,['latitude_deg','lat'],''), lon:first(a,['longitude_deg','lon'],''), heading:'', runway:'', length_ft:'' });
  }
  for (const r of runways) {
    const icao = String(first(r, ['airport_ident','airport_icao','icao','ident'], '')).toUpperCase();
    const le = first(r, ['le_ident','le_runway','runway','id'], '');
    const he = first(r, ['he_ident'], '');
    if (icao && le) rows.push({ airport_icao:icao, type:'runway', id:le, name:`Runway ${le}`, lat:first(r,['le_latitude_deg','lat'],''), lon:first(r,['le_longitude_deg','lon'],''), heading:first(r,['le_heading_degT','heading'],''), runway:le, length_ft:first(r,['length_ft'], '') });
    if (icao && he) rows.push({ airport_icao:icao, type:'runway', id:he, name:`Runway ${he}`, lat:first(r,['he_latitude_deg','lat'],''), lon:first(r,['he_longitude_deg','lon'],''), heading:first(r,['he_heading_degT','heading'],''), runway:he, length_ft:first(r,['length_ft'], '') });
  }
  for (const t of taxiways) {
    const icao = String(first(t, ['airport_icao','airport_ident','icao','AirportICAO','airport','airportIdentifier'], '')).toUpperCase();
    const id = first(t, ['id','identifier','taxiway','name','designator','txtDesig'], 'TWY');
    if (icao) rows.push({ airport_icao:icao, type:'taxiway', id, name:first(t,['name','taxiway_name','txtName'],id), lat:first(t,['lat','latitude','Latitude'],''), lon:first(t,['lon','longitude','Longitude'],''), heading:'', runway:'', length_ft:'' });
  }
  for (const a of aprons) {
    const icao = String(first(a, ['airport_icao','airport_ident','icao','AirportICAO','airport','airportIdentifier'], '')).toUpperCase();
    const id = first(a, ['id','identifier','apron','name','designator','txtName'], 'APRON');
    if (icao) rows.push({ airport_icao:icao, type:'ramp', id, name:first(a,['name','apron_name','txtName'],id), lat:first(a,['lat','latitude','Latitude'],''), lon:first(a,['lon','longitude','Longitude'],''), heading:'', runway:'', length_ft:'' });
  }
  return rows;
}

module.exports = { DEFAULT_NAVDATA_BASE_URL, FILES, BOOT_FILES, loadNavData, normalizeAirportRows };
