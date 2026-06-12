/*
 SkyEchoCabin FS2EFB Telemetry Normalizer v4.2.1
 Drop-in frontend patch.
 Purpose:
 - Accept FS2EFB AI Traffic Bridge ownship format.
 - Normalize altitudeFt -> altitude, headingMag -> heading, groundSpeedKt -> speed.
 - Treat traffic: [] as valid ownship telemetry, not NO TELEMETRY.
 - Does not alter ATC parser, PTT, audio, or traffic generation.
*/
(function(){
  'use strict';

  const PATCH_VERSION = '4.2.1-fs2efb-normalizer';

  function num(v, fallback = null){
    if (v === undefined || v === null || v === '') return fallback;
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }

  function firstNumber(obj, keys, fallback = null){
    if (!obj) return fallback;
    for (const k of keys){
      const n = num(obj[k], null);
      if (n !== null) return n;
    }
    return fallback;
  }

  function pickSourcePayload(raw){
    if (!raw || typeof raw !== 'object') return null;
    // FS2EFB Bridge v1.2.x shape
    if (raw.ownship && typeof raw.ownship === 'object') return raw.ownship;
    // SkyEchoLink/SayIntentions bridge shapes
    if (raw.lastTelemetry && typeof raw.lastTelemetry === 'object') return raw.lastTelemetry;
    if (raw.runtime && raw.runtime.lastTelemetry) return raw.runtime.lastTelemetry;
    if (raw.receiver && raw.receiver.latest) return raw.receiver.latest;
    // Already-flat telemetry shape
    return raw;
  }

  function normalizeTelemetry(raw){
    const src = pickSourcePayload(raw);
    const traffic = Array.isArray(raw?.traffic) ? raw.traffic : [];
    if (!src) {
      return {
        ok: false,
        status: 'NO TELEMETRY',
        missing: ['latitude','longitude','altitude','heading','speed'],
        traffic,
        raw
      };
    }

    const latitude = firstNumber(src, ['latitude','lat','PLANE LATITUDE']);
    const longitude = firstNumber(src, ['longitude','long','lon','lng','PLANE LONGITUDE']);
    const altitude = firstNumber(src, ['altitude','altitudeFt','GPSalt','BAROalt','indicatedAltitudeFt','PLANE ALTITUDE','INDICATED ALTITUDE']);
    const heading = firstNumber(src, ['heading','headingMag','MAGNhead','headingTrue','GPStrack','MAGNETIC COMPASS','PLANE HEADING DEGREES TRUE']);
    const speed = firstNumber(src, ['speed','groundSpeedKt','GRspeed','indicatedAirspeedKt','IAS','trueAirspeedKt','TAS','AIRSPEED INDICATED','AIRSPEED TRUE'], 0);
    const verticalSpeed = firstNumber(src, ['verticalSpeed','verticalSpeedFpm','VS','VERTICAL SPEED'], 0);
    const onGround = firstNumber(src, ['onGround','SIM ON GROUND'], null);
    const transponder = src.squawk ?? src.xpdr ?? src['TRANSPONDER CODE:1'] ?? src['TRANSPONDER CODE 1'] ?? '';
    const ageMs = firstNumber(src, ['ageMs'], null);

    const missing = [];
    if (latitude === null) missing.push('latitude');
    if (longitude === null) missing.push('longitude');
    if (altitude === null) missing.push('altitude');
    if (heading === null) missing.push('heading');
    // speed of 0 is valid on the ground, so only missing if null/undefined
    if (speed === null) missing.push('speed');

    const ok = missing.length === 0;

    return {
      ok,
      status: ok ? 'TELEMETRY OK' : 'NO TELEMETRY',
      source: src.source || raw?.receiver?.lastRawSource || raw?.source || 'fs2efb',
      callsign: src.callsign || raw?.session?.callsign || raw?.callsign || '',
      latitude,
      longitude,
      altitude,
      altitudeFt: altitude,
      heading,
      headingMag: heading,
      speed,
      groundSpeedKt: speed,
      verticalSpeed,
      onGround,
      transponder: String(transponder || ''),
      timestamp: src.timestamp || src.receivedAt || raw?.receiver?.lastPacketAt || raw?.timestamp || null,
      ageMs,
      traffic,
      trafficCount: Number.isFinite(Number(raw?.trafficCount)) ? Number(raw.trafficCount) : traffic.length,
      missing,
      raw
    };
  }

  // Expose safe global for existing panels/verifier to call.
  window.SkyEchoTelemetryNormalizer = {
    version: PATCH_VERSION,
    normalizeTelemetry
  };

  // Optional compatibility hook: if app uses window.normalizeTelemetry, do not clobber unless absent.
  if (typeof window.normalizeTelemetry !== 'function') {
    window.normalizeTelemetry = normalizeTelemetry;
  }

  // Optional fetch wrapper for /api/telemetry/state only.
  // Keeps existing API untouched but adds normalizedTelemetry to the JSON response.
  if (!window.__SKYECHO_FS2EFB_FETCH_PATCHED__) {
    window.__SKYECHO_FS2EFB_FETCH_PATCHED__ = true;
    const originalFetch = window.fetch.bind(window);
    window.fetch = async function(input, init){
      const res = await originalFetch(input, init);
      try {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        if (url.includes('/api/telemetry/state')) {
          const clone = res.clone();
          const data = await clone.json();
          const patched = Object.assign({}, data, {
            normalizedTelemetry: normalizeTelemetry(data)
          });
          return new Response(JSON.stringify(patched), {
            status: res.status,
            statusText: res.statusText,
            headers: { 'content-type': 'application/json' }
          });
        }
      } catch (_) {}
      return res;
    };
  }

  console.info('[SkyEcho] FS2EFB telemetry normalizer loaded:', PATCH_VERSION);
})();
