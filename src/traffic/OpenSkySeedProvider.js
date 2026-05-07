const { normalizeCallsign } = require('./SpawnManager');

const METERS_TO_FEET = 3.28084;
const MPS_TO_KNOTS = 1.94384;
const MPS_TO_FPM = 196.850394;

function num(v, fallback = null) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(v, min, max) { return Math.min(max, Math.max(min, v)); }

function airportCenter(airport) {
  if (!airport) return null;
  const rows = [...(airport.runways || []), ...(airport.raw || [])]
    .filter(r => Number.isFinite(Number(r.lat)) && Number.isFinite(Number(r.lon)));
  if (!rows.length) return null;
  const lat = rows.reduce((a, r) => a + Number(r.lat), 0) / rows.length;
  const lon = rows.reduce((a, r) => a + Number(r.lon), 0) / rows.length;
  return { lat, lon, icao: airport.icao };
}

function buildBox(center, radiusNm) {
  const latDelta = radiusNm / 60;
  const lonDelta = radiusNm / (60 * Math.max(0.25, Math.cos(center.lat * Math.PI / 180)));
  return {
    lamin: clamp(center.lat - latDelta, -90, 90),
    lamax: clamp(center.lat + latDelta, -90, 90),
    lomin: clamp(center.lon - lonDelta, -180, 180),
    lomax: clamp(center.lon + lonDelta, -180, 180),
    center
  };
}

function boxAreaDeg2(box) {
  return Math.abs((box.lamax - box.lamin) * (box.lomax - box.lomin));
}

function dedupeBoxes(boxes) {
  const out = [];
  for (const b of boxes) {
    const key = `${b.lamin.toFixed(2)}:${b.lomin.toFixed(2)}:${b.lamax.toFixed(2)}:${b.lomax.toFixed(2)}`;
    if (!out.some(x => x.key === key)) out.push({ ...b, key });
  }
  return out;
}

function parseStateVector(state) {
  if (!Array.isArray(state)) return null;
  const icao24 = String(state[0] || '').trim().toLowerCase();
  const rawCallsign = String(state[1] || '').trim();
  const lon = num(state[5]);
  const lat = num(state[6]);
  if (!icao24 || lat == null || lon == null) return null;
  const callsign = normalizeCallsign(rawCallsign || `N${icao24.slice(-4).toUpperCase()}`);
  const altM = num(state[7], num(state[13], 0));
  const velMps = num(state[9], 0);
  const vsMps = num(state[11], 0);
  return {
    icao24,
    callsign,
    spokenCallsign: callsign,
    originCountry: String(state[2] || ''),
    lat,
    lon,
    altitudeFt: Math.round((altM || 0) * METERS_TO_FEET),
    onGround: !!state[8],
    groundSpeedKt: Math.max(0, Math.round((velMps || 0) * MPS_TO_KNOTS)),
    heading: num(state[10], 0),
    verticalRateFpm: Math.round((vsMps || 0) * MPS_TO_FPM),
    squawk: state[14] ? String(state[14]) : null,
    category: state[17] ?? null,
    source: 'opensky'
  };
}

class OpenSkySeedProvider {
  constructor({ config = {}, airports = new Map(), log = () => {} } = {}) {
    this.config = config;
    this.airports = airports;
    this.log = log;
    this.cache = new Map();
    this.token = null;
    this.tokenExpiresAt = 0;
  }

  enabled() { return !!this.config.openSkyEnabled; }

  cacheKey(scopeAirports = [], boxes = []) {
    const aps = [...scopeAirports].sort().join('-') || 'local';
    const hourBucket = Math.floor(Date.now() / Number(this.config.openSkyCacheTtlMs || 1800000));
    const bk = boxes.map(b => `${b.lamin.toFixed(1)},${b.lomin.toFixed(1)},${b.lamax.toFixed(1)},${b.lomax.toFixed(1)}`).join('|');
    return `${aps}:${hourBucket}:${bk}`;
  }

  buildBoxes({ scopeAirports = [], airport, origin, dest, route } = {}) {
    const set = new Set();
    const add = v => String(v || '').split(/[\s,;>]+/).map(x => x.trim().toUpperCase()).filter(Boolean).forEach(x => { if (/^[A-Z0-9]{3,4}$/.test(x)) set.add(x); });
    add(airport); add(origin); add(dest); add(route); [...scopeAirports].forEach(add);
    const radius = Number(this.config.openSkyRouteBubbleNm || 80);
    const maxCalls = Math.max(1, Number(this.config.openSkyMaxCallsPerSession || 3));
    const boxes = [];
    for (const icao of set) {
      const center = airportCenter(this.airports.get(icao));
      if (center) boxes.push(buildBox(center, radius));
      if (boxes.length >= maxCalls) break;
    }
    // Fallback Caribbean box so the app still seeds if airport rows are limited.
    if (!boxes.length) {
      boxes.push({ lamin: 16.5, lomin: -63.5, lamax: 18.5, lomax: -61.0, center: { icao: 'CARIB', lat: 17.5, lon: -62.25 } });
    }
    return dedupeBoxes(boxes).slice(0, maxCalls).map(b => {
      // Keep anonymous calls cheap: shrink any overly large area.
      const maxDeg = Number(this.config.openSkyMaxBoxDeg2 || 25);
      if (boxAreaDeg2(b) <= maxDeg) return b;
      const center = b.center || { lat: (b.lamin+b.lamax)/2, lon: (b.lomin+b.lomax)/2 };
      return buildBox(center, Math.min(radius, 60));
    });
  }

  async getToken() {
    const id = this.config.openSkyClientId;
    const secret = this.config.openSkyClientSecret;
    if (!id || !secret) return null;
    if (this.token && Date.now() < this.tokenExpiresAt - 60000) return this.token;
    const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret });
    const res = await fetch('https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body
    });
    if (!res.ok) throw new Error(`OpenSky OAuth failed ${res.status}`);
    const data = await res.json();
    this.token = data.access_token;
    this.tokenExpiresAt = Date.now() + Math.max(60, Number(data.expires_in || 1800)) * 1000;
    return this.token;
  }

  async fetchBox(box) {
    const url = new URL('https://opensky-network.org/api/states/all');
    url.searchParams.set('lamin', String(box.lamin));
    url.searchParams.set('lomin', String(box.lomin));
    url.searchParams.set('lamax', String(box.lamax));
    url.searchParams.set('lomax', String(box.lomax));
    url.searchParams.set('extended', '1');
    const headers = {};
    const token = await this.getToken();
    if (token) headers.authorization = `Bearer ${token}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Number(this.config.openSkyTimeoutMs || 8000));
    try {
      const res = await fetch(url, { headers, signal: controller.signal });
      if (!res.ok) throw new Error(`OpenSky states failed HTTP ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timeout);
    }
  }

  async seedTraffic(opts = {}) {
    if (!this.enabled()) return { ok: false, reason: 'OpenSky disabled', aircraft: [], boxes: [] };
    const boxes = this.buildBoxes(opts);
    const key = this.cacheKey(opts.scopeAirports || [], boxes);
    const ttl = Number(this.config.openSkyCacheTtlMs || 1800000);
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.t < ttl) return { ...cached.value, cached: true };

    const all = [];
    const errors = [];
    for (const box of boxes) {
      try {
        const data = await this.fetchBox(box);
        for (const s of data.states || []) {
          const ac = parseStateVector(s);
          if (ac) all.push(ac);
        }
      } catch (e) {
        errors.push(e.message);
      }
    }
    const unique = [];
    const seen = new Set();
    for (const ac of all) {
      if (seen.has(ac.icao24)) continue;
      seen.add(ac.icao24);
      unique.push(ac);
    }
    const max = Number(this.config.openSkyMaxAircraft || this.config.aiSessionAircraftMax || 7);
    unique.sort((a, b) => (a.onGround === b.onGround ? 0 : a.onGround ? -1 : 1));
    const value = { ok: unique.length > 0, source: 'opensky', boxes: boxes.map(({key, ...b}) => b), errors, aircraft: unique.slice(0, max), fetchedAt: Date.now() };
    this.cache.set(key, { t: Date.now(), value });
    return value;
  }
}

module.exports = { OpenSkySeedProvider };
