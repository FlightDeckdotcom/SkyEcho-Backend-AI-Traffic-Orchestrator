// SkyEcho Volanta Bridge v6.9.54 UltraStrict
// Volanta is optional tracking/session/logging. FS2EFB is source of truth.

const state = {
  active: false,
  sessionId: null,
  startedAt: null,
  stoppedAt: null,
  flight: null,
  lastTelemetry: null,
  lastSnapshot: null,
  lastForward: null,
  lastError: null,
  history: []
};

function nowIso() { return new Date().toISOString(); }
function newSessionId() { return `skyecho-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`; }

function compactTelemetry(t = {}) {
  return {
    timestamp: t.timestamp || nowIso(),
    callsign: t.callsign || "",
    latitude: t.latitude ?? t.lat ?? null,
    longitude: t.longitude ?? t.lon ?? t.lng ?? null,
    altitude: t.altitude ?? t.alt ?? null,
    heading: t.heading ?? t.hdg ?? null,
    groundSpeed: t.groundSpeed ?? t.groundspeed ?? t.gs ?? t.speed ?? null,
    verticalSpeed: t.verticalSpeed ?? t.vs ?? null,
    onGround: Boolean(t.onGround ?? t.simOnGround ?? false),
    com1: t.com1 ?? t.radio ?? null,
    transponder: t.transponder ?? t.squawk ?? null,
    source: t.source || "fs2efb"
  };
}

export function getVolantaHealth(config = {}) {
  return {
    ok: true,
    service: "skyecho-volanta-bridge",
    version: "6.9.54",
    purpose: "optional tracking/session/logging bridge",
    officialVolantaApiClaim: false,
    mode: config.mode || "standby",
    webhookConfigured: Boolean(config.webhookUrl),
    apiConfigured: Boolean(config.apiUrl && config.apiKeyConfigured),
    fs2efbConfigured: Boolean(config.fs2efbConfigured),
    activeSession: state.active,
    sessionId: state.sessionId,
    lastForward: state.lastForward,
    lastError: state.lastError
  };
}

export function startVolantaSession(flight = {}) {
  state.active = true;
  state.sessionId = state.sessionId || newSessionId();
  state.startedAt = state.startedAt || nowIso();
  state.stoppedAt = null;
  state.flight = {
    callsign: flight.callsign || flight.flightNumber || "",
    aircraft: flight.aircraft || flight.aircraftType || "",
    origin: flight.origin || flight.departure || "",
    destination: flight.destination || flight.dest || "",
    route: flight.route || "",
    cruiseAltitude: flight.cruiseAltitude || flight.cruise || "",
    simbriefId: flight.simbriefId || flight.simbriefPilotId || "",
    raw: flight
  };
  state.history.push({ type: "session_start", timestamp: nowIso(), flight: state.flight });
  return getVolantaSession();
}

export function stopVolantaSession(payload = {}) {
  state.active = false;
  state.stoppedAt = nowIso();
  state.history.push({ type: "session_stop", timestamp: state.stoppedAt, payload });
  return getVolantaSession();
}

export function getVolantaSession() {
  return {
    active: state.active,
    sessionId: state.sessionId,
    startedAt: state.startedAt,
    stoppedAt: state.stoppedAt,
    flight: state.flight,
    lastTelemetry: state.lastTelemetry,
    lastSnapshot: state.lastSnapshot,
    lastForward: state.lastForward,
    lastError: state.lastError,
    historyCount: state.history.length
  };
}

export function derivePhaseHint(t = {}) {
  if (!t) return "unknown";
  if (t.onGround && (!t.groundSpeed || t.groundSpeed < 5)) return "parked";
  if (t.onGround && t.groundSpeed >= 5) return "taxi";
  if (!t.onGround && t.altitude !== null && t.altitude < 3000) return "departure_or_final";
  if (!t.onGround && t.altitude !== null && t.altitude < 18000) return "climb_or_descent";
  if (!t.onGround && t.altitude !== null && t.altitude >= 18000) return "enroute";
  return "unknown";
}

export function buildVolantaSnapshot(telemetry = null) {
  const t = telemetry ? compactTelemetry(telemetry) : state.lastTelemetry;
  const snapshot = {
    sessionId: state.sessionId,
    active: state.active,
    timestamp: nowIso(),
    flight: state.flight,
    telemetry: t,
    phaseHint: derivePhaseHint(t),
    loggable: Boolean(state.active && t?.latitude !== null && t?.longitude !== null)
  };
  state.lastSnapshot = snapshot;
  return snapshot;
}

export async function ingestVolantaTelemetry(telemetry = {}, config = {}) {
  const compact = compactTelemetry(telemetry);
  state.lastTelemetry = compact;
  const snapshot = buildVolantaSnapshot(compact);
  state.history.push({ type: "telemetry", timestamp: nowIso(), telemetry: compact });

  if (!state.active) return { forwarded: false, reason: "no_active_session", snapshot };

  if (config.mode === "webhook" && config.webhookUrl) {
    try {
      const r = await fetch(config.webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(snapshot)
      });
      state.lastForward = { timestamp: nowIso(), mode: "webhook", status: r.status };
      state.lastError = r.ok ? null : `Webhook HTTP ${r.status}`;
      return { forwarded: r.ok, mode: "webhook", status: r.status, snapshot };
    } catch (e) {
      state.lastError = e.message;
      return { forwarded: false, mode: "webhook", error: e.message, snapshot };
    }
  }

  if (config.mode === "api" && config.apiUrl && config.apiKey) {
    try {
      const r = await fetch(config.apiUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${config.apiKey}`,
          "x-api-key": config.apiKey
        },
        body: JSON.stringify(snapshot)
      });
      state.lastForward = { timestamp: nowIso(), mode: "api", status: r.status };
      state.lastError = r.ok ? null : `API HTTP ${r.status}`;
      return { forwarded: r.ok, mode: "api", status: r.status, snapshot };
    } catch (e) {
      state.lastError = e.message;
      return { forwarded: false, mode: "api", error: e.message, snapshot };
    }
  }

  return { forwarded: false, reason: "standby_or_local_mode", mode: config.mode || "standby", snapshot };
}
