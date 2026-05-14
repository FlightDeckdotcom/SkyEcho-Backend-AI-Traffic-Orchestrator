'use strict';

const { OpenSkyTokenManager } = require('./OpenSkyTokenManager');

const M_TO_FT = 3.280839895;
const MS_TO_KT = 1.94384449;

function toRad(d) {
  return d * Math.PI / 180;
}

function distanceNm(aLat, aLon, bLat, bLon) {
  const Rnm = 3440.065;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const lat1 = toRad(aLat);
  const lat2 = toRad(bLat);

  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);

  return 2 * Rnm * Math.asin(Math.sqrt(x));
}

function boundingBox(lat, lon, radiusNm) {
  const latDelta = radiusNm / 60;
  const lonDelta =
    radiusNm / (60 * Math.max(0.15, Math.cos(toRad(lat))));

  return {
    lamin: lat - latDelta,
    lamax: lat + latDelta,
    lomin: lon - lonDelta,
    lomax: lon + lonDelta
  };
}

function cleanCallsign(raw, fallback) {
  return String(raw || '')
    .trim()
    .replace(/\s+/g, '') || fallback;
}

function stateVectorToAircraft(row, center, nowSec) {
  const [
    icao24,
    callsignRaw,
    originCountry,
    timePosition,
    lastContact,
    lon,
    lat,
    baroAltM,
    onGround,
    velocityMs,
    trueTrack,
    verticalRateMs,
    sensors,
    geoAltM,
    squawk,
    spi,
    positionSource,
    category
  ] = row;

  if (lat == null || lon == null) {
    return null;
  }

  const callsign = cleanCallsign(
    callsignRaw,
    `OS${String(icao24 || '').slice(-4).toUpperCase()}`
  );

  const distance = distanceNm(center.lat, center.lon, lat, lon);

  const altitudeFt =
    Math.round(((baroAltM ?? geoAltM ?? 0) * M_TO_FT) / 100) * 100;

  return {
    id: `opensky_${String(icao24 || callsign).toLowerCase()}`,
    source: 'opensky',
    icao24,
    callsign,
    originCountry,
    category,
    positionSource,
    timePosition,
    lastContact,
    ageSec:
      nowSec && lastContact
        ? Math.max(0, nowSec - lastContact)
        : null,
    distanceNm: Math.round(distance * 10) / 10,
    squawk: squawk || null,
    adsb: {
      icao24,
      callsign,
      squawk: squawk || null,
      lat,
      lon,
      altitude: altitudeFt,
      geoAltitude:
        geoAltM == null
          ? null
          : Math.round((geoAltM * M_TO_FT) / 100) * 100,
      heading: trueTrack == null ? 0 : Math.round(trueTrack),
      groundSpeed:
        velocityMs == null ? 0 : Math.round(velocityMs * MS_TO_KT),
      verticalRate:
        verticalRateMs == null
          ? 0
          : Math.round((verticalRateMs * M_TO_FT * 60) / 100) * 100,
      onGround: !!onGround,
      source: positionSource
    }
  };
}

class OpenSkyLiveProvider {
  constructor({
    tokenManager,
    fetchImpl,
    env = process.env,
    log = console.log
  } = {}) {
    this.fetch = fetchImpl || global.fetch;
    this.env = env;
    this.log = log;

    this.tokenManager =
      tokenManager ||
      new OpenSkyTokenManager({
        fetchImpl: this.fetch,
        env,
        log
      });

    this.baseUrl =
      env.OPENSKY_BASE_URL || 'https://opensky-network.org/api';

    this.lastSync = null;
    this.lastError = null;
    this.lastRateLimit = {};
  }

  enabled() {
    return (
      String(this.env.OPENSKY_ENABLED || 'false').toLowerCase() ===
      'true'
    );
  }

  defaultRadiusNm() {
    return Math.max(
      5,
      Math.min(150, Number(this.env.OPENSKY_RADIUS_NM || 50))
    );
  }

  maxAircraft() {
    return Math.max(
      1,
      Math.min(100, Number(this.env.OPENSKY_MAX_AIRCRAFT || 20))
    );
  }

  buildUrl({ lat, lon, radiusNm }) {
    const b = boundingBox(
      Number(lat),
      Number(lon),
      Number(radiusNm || this.defaultRadiusNm())
    );

    const q = new URLSearchParams({
      lamin: String(b.lamin),
      lomin: String(b.lomin),
      lamax: String(b.lamax),
      lomax: String(b.lomax),
      extended: '1'
    });

    return `${this.baseUrl}/states/all?${q.toString()}`;
  }

  async fetchNearby({ lat, lon, radiusNm, maxAircraft } = {}) {
    if (!this.enabled()) {
      return {
        ok: false,
        disabled: true,
        aircraft: [],
        note: 'OPENSKY_ENABLED is not true'
      };
    }

    if (
      !Number.isFinite(Number(lat)) ||
      !Number.isFinite(Number(lon))
    ) {
      throw new Error('OpenSky sync requires numeric lat/lon');
    }

    if (!this.fetch) {
      throw new Error('global fetch unavailable; use Node 18+');
    }

    const radius = Number(radiusNm || this.defaultRadiusNm());

    const url = this.buildUrl({
      lat,
      lon,
      radiusNm: radius
    });

    let headers = {};
    let authMode = 'anonymous';

    // Try OAuth first. If Render cannot reach the OAuth token URL,
    // continue anonymously so we can still test OpenSky state fetching.
    try {
      headers = await this.tokenManager.headers();
      authMode = headers.Authorization ? 'oauth2' : 'anonymous';
    } catch (err) {
      this.lastError =
        'OpenSky OAuth failed, falling back anonymous: ' +
        `${err && err.message ? err.message : String(err)}`;

      headers = {};
      authMode = 'anonymous_fallback';
    }

    let res;

    try {
      res = await this.fetch(url, {
        headers
      });
    } catch (err) {
      this.lastError =
        `OpenSky states fetch failed using ${authMode} at ${url}: ` +
        `${err && err.message ? err.message : String(err)}`;

      throw new Error(this.lastError);
    }

    let text = '';

    try {
      text = await res.text();
    } catch (err) {
      this.lastError =
        'OpenSky states response could not be read: ' +
        `${err && err.message ? err.message : String(err)}`;

      throw new Error(this.lastError);
    }

    this.lastRateLimit = {
      remaining: res.headers.get('x-rate-limit-remaining'),
      retryAfterSec: res.headers.get('x-rate-limit-retry-after-seconds')
    };

    if (!res.ok) {
      this.lastError =
        `OpenSky HTTP ${res.status} using ${authMode}: ` +
        text.slice(0, 500);

      throw new Error(this.lastError);
    }

    let json;

    try {
      json = JSON.parse(text);
    } catch (err) {
      this.lastError =
        'OpenSky states response was not valid JSON: ' +
        text.slice(0, 500);

      throw new Error(this.lastError);
    }

    const states = Array.isArray(json.states) ? json.states : [];

    const center = {
      lat: Number(lat),
      lon: Number(lon)
    };

    const nowSec = Number(
      json.time || Math.floor(Date.now() / 1000)
    );

    const aircraft = states
      .map((row) => stateVectorToAircraft(row, center, nowSec))
      .filter(Boolean)
      .filter((ac) => ac.distanceNm <= radius)
      .sort((a, b) => a.distanceNm - b.distanceNm)
      .slice(0, Number(maxAircraft || this.maxAircraft()));

    const warning =
      authMode === 'anonymous_fallback' ? this.lastError : null;

    this.lastSync = {
      at: Date.now(),
      ok: true,
      authMode,
      radiusNm: radius,
      received: states.length,
      accepted: aircraft.length,
      time: json.time,
      rateLimit: this.lastRateLimit,
      warning
    };

    // Clear hard errors only when the full OAuth path worked.
    // Keep warning visible when anonymous fallback was used.
    if (authMode !== 'anonymous_fallback') {
      this.lastError = null;
    }

    return {
      ok: true,
      source: 'opensky',
      authMode,
      time: json.time,
      radiusNm: radius,
      received: states.length,
      accepted: aircraft.length,
      aircraft,
      rateLimit: this.lastRateLimit,
      warning
    };
  }

  snapshot() {
    return {
      enabled: this.enabled(),
      configured: this.tokenManager.configured(),
      radiusNm: this.defaultRadiusNm(),
      maxAircraft: this.maxAircraft(),
      token: this.tokenManager.snapshot(),
      lastSync: this.lastSync,
      lastError: this.lastError,
      rateLimit: this.lastRateLimit
    };
  }
}

module.exports = {
  OpenSkyLiveProvider,
  boundingBox,
  distanceNm,
  stateVectorToAircraft
};
