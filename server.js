import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";

import {
  createAtcSession,
  getAtcSession,
  handlePilotTransmission,
  ingestTelemetry,
  getEngineHealth
} from "./src/core/skyEchoAtcEngine.js";

import { parseSimBriefLikeRoute } from "./src/core/routeTools.js";

import {
  getVolantaHealth,
  startVolantaSession,
  stopVolantaSession,
  getVolantaSession,
  ingestVolantaTelemetry,
  buildVolantaSnapshot
} from "./src/connectors/volantaBridge.js";

import {
  buildSayIntentionsPayload,
  sendToSayIntentionsIfEnabled
} from "./src/connectors/sayIntentionsAdapter.js";

import {
  makeResponse,
  parseFlightPlan,
  deriveTelemetryPhase
} from "./src/atc/SkyEchoAtcNavEngine.js";

const app = express();

app.use(cors());
app.use(express.json({ limit: "4mb" }));
app.use(express.text({ limit: "2mb", type: ["text/*", "application/octet-stream"] }));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 10000;
const VERSION = "7.0.0";

const FS2EFB_URL = process.env.FS2EFB_URL || process.env.FS2EFB_ENDPOINT || "";
const SIMBRIEF_USER_ID = process.env.SIMBRIEF_USER_ID || process.env.SIMBRIEF_PILOT_ID || "";

const VOLANTA_MODE = process.env.VOLANTA_MODE || "standby";
const VOLANTA_WEBHOOK_URL = process.env.VOLANTA_WEBHOOK_URL || "";
const VOLANTA_API_URL = process.env.VOLANTA_API_URL || "";
const VOLANTA_API_KEY = process.env.VOLANTA_API_KEY || "";

const SAYINTENTIONS_ADAPTER_ENABLED = /^true$/i.test(process.env.SAYINTENTIONS_ADAPTER_ENABLED || "false");
const SAYINTENTIONS_SIMAPI_URL = process.env.SAYINTENTIONS_SIMAPI_URL || "";
const SAYINTENTIONS_API_KEY = process.env.SAYINTENTIONS_API_KEY || "";

const runtime = {
  fs2efb: {
    lastPoll: null,
    lastIngest: null,
    lastError: null,
    lastData: null
  },
  lastSayIntentionsForward: null,
  atcNav: {
    active: false,
    id: null,
    createdAt: null,
    callsign: "",
    phase: "preflight",
    controller: "Clearance",
    expectedReadback: [],
    expectedReadbackType: "none",
    flightPlan: {},
    telemetry: null,
    lastPilotTransmission: null,
    lastAtcTransmission: null,
    lastIntent: null,
    phaseReason: null,
    history: []
  }
};

app.use("/frontend", express.static(path.join(__dirname, "frontend")));
app.use("/public", express.static(path.join(__dirname, "public")));
app.use("/assets", express.static(path.join(__dirname, "assets")));

function safeJson(text) {
  if (typeof text !== "string") return text || {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function num(v) {
  if (v === "" || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function parseBool(v) {
  if (typeof v === "boolean") return v;
  if (v == null) return false;
  return /^(true|1|yes|ground|onground)$/i.test(String(v));
}

function cleanCallsign(v) {
  return String(v || "").trim().toUpperCase().replace(/\s+/g, "");
}

function metersToFeet(v) {
  const n = num(v);
  return n == null ? null : Math.round(n * 3.28084);
}

function routeTextFromBody(f = {}) {
  return f.route || f.routeRaw || f.flight?.route || "";
}

function inferProceduresFromParsedRoute(route = "", parsed = {}) {
  const tokens = String(route || "").toUpperCase().split(/\s+/).filter(Boolean);
  const procedures = tokens.filter(t => /^[A-Z]{2,6}\d[A-Z]?$/.test(t) && !/^[A-Z]{1,2}\d{1,4}[A-Z]?$/.test(t));
  return {
    sid: parsed.sid || parsed.departureProcedure || procedures[0] || "",
    star: parsed.star || parsed.arrivalProcedure || procedures.length > 1 ? procedures[procedures.length - 1] : ""
  };
}

function buildFlightPlanFromBody(f = {}) {
  const route = routeTextFromBody(f);
  let parsed = {};
  try {
    parsed = parseSimBriefLikeRoute(route) || {};
  } catch {
    parsed = {};
  }

  const inferred = inferProceduresFromParsedRoute(route, parsed);

  return parseFlightPlan({
    callsign: f.callsign || f.flightNumber || f.flight?.callsign || runtime.atcNav.callsign || "AAL318",
    aircraft: f.aircraft || f.aircraftType || f.flight?.aircraft || "B738",
    origin: f.origin || f.departure || f.airport || f.flight?.origin || "",
    destination: f.destination || f.dest || f.arrival || f.flight?.destination || "",
    route,
    sid: f.sid || f.departureProcedure || parsed.sid || parsed.departureProcedure || inferred.sid || "",
    star: f.star || f.arrivalProcedure || parsed.star || parsed.arrivalProcedure || inferred.star || "",
    requestedApproach: f.requestedApproach || f.approach || runtime.atcNav.flightPlan?.requestedApproach || "",
    arrRunway: f.arrRunway || f.runway || f.assignedRunway || runtime.atcNav.flightPlan?.arrRunway || "",
    cruiseAltitude: f.cruiseAltitude || f.cruise || runtime.atcNav.flightPlan?.cruiseAltitude || "",
    assignedSquawk: f.assignedSquawk || f.squawk || runtime.atcNav.flightPlan?.assignedSquawk || ""
  });
}

function normalizeFs2EfbTelemetry(raw = {}) {
  const root = typeof raw === "string" ? safeJson(raw) : raw || {};
  const src = root?.aircraft || root?.telemetry || root?.data || root?.state || root || {};
  const pos = src.position || src.pos || root.position || {};
  const kv = src.kv || root.kv || root.raw?.kv || root.raw?.raw?.kv || {};

  const gpsAlt = kv.gpsalt ?? src.GPSalt ?? src.gpsAlt ?? src.gpsalt;
  const baroAlt = kv.baroalt ?? src.BAROalt ?? src.baroAlt ?? src.baroalt;
  const aglAlt = kv.aglalt ?? src.AGLalt ?? src.aglAlt ?? src.aglalt;

  let altitude =
    num(src.altitude ?? src.alt ?? src.baro_altitude ?? pos.altitude);

  if (altitude == null && gpsAlt != null) altitude = metersToFeet(gpsAlt);
  if (altitude == null && baroAlt != null) altitude = metersToFeet(baroAlt);
  if (altitude == null && aglAlt != null) altitude = metersToFeet(aglAlt);

  const callsign =
    cleanCallsign(src.callsign || src.callSign || src.flight || src.atc_id || root.callsign) ||
    cleanCallsign(runtime.atcNav.callsign) ||
    cleanCallsign(getAtcSession()?.callsign);

  return {
    source: "fs2efb",
    timestamp: new Date().toISOString(),
    callsign,
    latitude: num(src.lat ?? src.latitude ?? pos.lat ?? pos.latitude ?? kv.lat ?? kv.latitude),
    longitude: num(src.lon ?? src.lng ?? src.long ?? src.longitude ?? pos.lon ?? pos.lng ?? pos.longitude ?? kv.lon ?? kv.lng ?? kv.long ?? kv.longitude),
    altitude,
    heading: num(src.heading ?? src.hdg ?? src.track ?? src.trueHeading ?? kv.magnhead ?? kv.heading ?? kv.hdg ?? kv.gpstrack),
    groundSpeed: num(src.groundSpeed ?? src.groundspeed ?? src.gs ?? src.speed ?? kv.grspeed ?? kv.gs ?? kv.tas),
    indicatedAirspeed: num(src.ias ?? src.indicatedAirspeed ?? kv.ias),
    verticalSpeed: num(src.verticalSpeed ?? src.vs ?? src.vertical_speed ?? kv.vs),
    distanceToDestination: num(src.distanceToDestination ?? src.distToDest ?? src.distance_nm_dest ?? kv.disttodest),
    distanceFromOrigin: num(src.distanceFromOrigin ?? src.distFromOrigin ?? src.distance_nm_origin),
    onGround: parseBool(src.onGround ?? src.simOnGround ?? src.ground ?? kv.onground),
    com1: src.com1 ?? src.com1Active ?? src.radio ?? src.frequency ?? kv.com1 ?? kv.freq ?? null,
    transponder: src.squawk ?? src.transponder ?? kv.xpdr ?? null,
    raw: root
  };
}

function syncNavPhaseWithTelemetry(telemetry) {
  const phase = deriveTelemetryPhase(
    runtime.atcNav.flightPlan || {},
    telemetry || {},
    "",
    runtime.atcNav || {}
  );

  runtime.atcNav.telemetry = telemetry;
  runtime.atcNav.phase = phase.phase;
  runtime.atcNav.controller = phase.controller;
  runtime.atcNav.phaseReason = phase.reason;

  return phase;
}

function pushHistory(item) {
  runtime.atcNav.history = [
    ...(runtime.atcNav.history || []),
    {
      timestamp: new Date().toISOString(),
      ...item
    }
  ].slice(-100);
}

async function handleTelemetry(telemetry) {
  runtime.fs2efb.lastData = telemetry;
  runtime.fs2efb.lastError = null;
  runtime.fs2efb.lastIngest = telemetry.timestamp || new Date().toISOString();

  let legacyEngine = null;
  try {
    legacyEngine = ingestTelemetry(telemetry);
  } catch (e) {
    legacyEngine = { ok: false, error: e.message };
  }

  const phase = syncNavPhaseWithTelemetry(telemetry);

  pushHistory({
    type: "telemetry",
    phase: phase.phase,
    controller: phase.controller,
    reason: phase.reason,
    telemetry
  });

  const volanta = await ingestVolantaTelemetry(telemetry, {
    mode: VOLANTA_MODE,
    webhookUrl: VOLANTA_WEBHOOK_URL,
    apiUrl: VOLANTA_API_URL,
    apiKey: VOLANTA_API_KEY
  });

  const si = await sendToSayIntentionsIfEnabled(
    buildSayIntentionsPayload(telemetry, getAtcSession()),
    {
      enabled: SAYINTENTIONS_ADAPTER_ENABLED,
      url: SAYINTENTIONS_SIMAPI_URL,
      apiKey: SAYINTENTIONS_API_KEY
    }
  );

  runtime.lastSayIntentionsForward = si;

  return {
    engine: {
      legacy: legacyEngine,
      nav: {
        phase: runtime.atcNav.phase,
        controller: runtime.atcNav.controller,
        phaseReason: runtime.atcNav.phaseReason,
        expectedReadback: runtime.atcNav.expectedReadback
      }
    },
    volanta,
    sayIntentions: si
  };
}

async function pollFs2Efb() {
  if (!FS2EFB_URL) return { ok: false, error: "FS2EFB_URL/FS2EFB_ENDPOINT not configured." };

  try {
    const r = await fetch(FS2EFB_URL, { cache: "no-store" });
    const telemetry = normalizeFs2EfbTelemetry(safeJson(await r.text()));
    runtime.fs2efb.lastPoll = new Date().toISOString();
    const result = await handleTelemetry(telemetry);
    return { ok: true, telemetry, ...result };
  } catch (e) {
    runtime.fs2efb.lastError = e.message;
    return { ok: false, error: e.message };
  }
}

function startCoreSession(f = {}) {
  const fp = buildFlightPlanFromBody(f);

  let legacySession = null;
  try {
    legacySession = createAtcSession({
      callsign: fp.callsign || "AAL318",
      aircraft: fp.aircraft || "B738",
      origin: fp.origin || "",
      destination: fp.destination || "",
      route: fp.routeRaw || "",
      cruiseAltitude: fp.cruiseAltitude || "",
      simbriefId: f.simbriefId || SIMBRIEF_USER_ID || "",
      runway: fp.arrRunway || f.runway || ""
    });
  } catch (e) {
    legacySession = { ok: false, error: e.message };
  }

  runtime.atcNav = {
    active: true,
    id: "skyecho-core-" + Date.now(),
    createdAt: new Date().toISOString(),
    callsign: fp.callsign,
    phase: "preflight",
    controller: "Clearance",
    expectedReadback: [],
    expectedReadbackType: "none",
    flightPlan: fp,
    telemetry: runtime.fs2efb.lastData,
    lastPilotTransmission: null,
    lastAtcTransmission: null,
    lastIntent: null,
    phaseReason: "session_start",
    history: []
  };

  if (runtime.fs2efb.lastData) {
    syncNavPhaseWithTelemetry(runtime.fs2efb.lastData);
  }

  startVolantaSession({
    ...f,
    callsign: fp.callsign,
    aircraft: fp.aircraft,
    origin: fp.origin,
    destination: fp.destination,
    route: fp.routeRaw,
    cruiseAltitude: fp.cruiseAltitude
  });

  return {
    legacySession,
    navSession: runtime.atcNav
  };
}

function respondToPilotTranscript(text = "", body = {}) {
  const mergedFp = parseFlightPlan({
    ...(runtime.atcNav.flightPlan || {}),
    ...(body.flightPlan || {}),
    callsign: body.callsign || body.flight?.callsign || runtime.atcNav.callsign || runtime.atcNav.flightPlan?.callsign,
    aircraft: body.aircraft || body.flight?.aircraft || runtime.atcNav.flightPlan?.aircraft,
    origin: body.origin || body.departure || body.flight?.origin || runtime.atcNav.flightPlan?.origin,
    destination: body.destination || body.dest || body.arrival || body.flight?.destination || runtime.atcNav.flightPlan?.destination,
    route: body.route || body.routeRaw || body.flight?.route || runtime.atcNav.flightPlan?.routeRaw,
    sid: body.sid || body.departureProcedure || runtime.atcNav.flightPlan?.sid,
    star: body.star || body.arrivalProcedure || runtime.atcNav.flightPlan?.star,
    requestedApproach: body.requestedApproach || body.approach || runtime.atcNav.flightPlan?.requestedApproach,
    arrRunway: body.arrRunway || body.runway || body.assignedRunway || runtime.atcNav.flightPlan?.arrRunway,
    cruiseAltitude: body.cruiseAltitude || body.cruise || runtime.atcNav.flightPlan?.cruiseAltitude,
    assignedSquawk: body.assignedSquawk || body.squawk || runtime.atcNav.flightPlan?.assignedSquawk
  });

  runtime.atcNav.flightPlan = mergedFp;
  runtime.atcNav.callsign = mergedFp.callsign || runtime.atcNav.callsign;

  const telemetry = body.telemetry || runtime.fs2efb.lastData || runtime.atcNav.telemetry || {};

  let navResult = null;
  try {
    navResult = makeResponse(text, mergedFp, telemetry, runtime.atcNav);
  } catch (e) {
    navResult = {
      ok: false,
      atcResponseText: `${runtime.atcNav.callsign || "Aircraft"}, say again.`,
      updatedState: runtime.atcNav,
      debug: { error: e.message }
    };
  }

  runtime.atcNav = {
    ...runtime.atcNav,
    ...navResult.updatedState,
    active: true,
    flightPlan: mergedFp,
    telemetry,
    lastPilotTransmission: text,
    lastAtcTransmission: navResult.atcResponseText,
    history: runtime.atcNav.history || []
  };

  pushHistory({
    type: "pilot_transmission",
    transcript: text,
    response: navResult.atcResponseText,
    debug: navResult.debug
  });

  // Legacy engine remains as a fallback/debug path only. It no longer controls the primary ATC text.
  let legacy = null;
  try {
    legacy = handlePilotTransmission(text, { telemetry });
  } catch (e) {
    legacy = { ok: false, error: e.message };
  }

  return {
    atc: navResult.atcResponseText,
    atcResponseText: navResult.atcResponseText,
    response: navResult.atcResponseText,
    engine: runtime.atcNav,
    debug: navResult.debug,
    legacy
  };
}

app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "SkyEchoCabin Core Engine",
    version: VERSION,
    app: "/app/"
  });
});

app.get(["/app", "/app/"], (req, res) => {
  res.sendFile(path.join(__dirname, "frontend", "index.html"));
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    version: VERSION,
    architecture: "FS2EFB telemetry + SimBrief route + SkyEcho ATC Nav Engine v7 + optional Volanta/SayIntentions adapters",
    fs2efbConfigured: Boolean(FS2EFB_URL),
    simbriefConfigured: Boolean(SIMBRIEF_USER_ID),
    volantaMode: VOLANTA_MODE,
    sayIntentionsAdapterEnabled: SAYINTENTIONS_ADAPTER_ENABLED,
    engine: {
      legacy: getEngineHealth(),
      nav: {
        active: runtime.atcNav.active,
        sessionId: runtime.atcNav.id,
        phase: runtime.atcNav.phase,
        controller: runtime.atcNav.controller,
        callsign: runtime.atcNav.callsign,
        routeTokens: runtime.atcNav.flightPlan?.routeTokens || [],
        routeFixes: runtime.atcNav.flightPlan?.routeFixes || [],
        routeAirways: runtime.atcNav.flightPlan?.routeAirways || [],
        procedures: runtime.atcNav.flightPlan?.procedures || [],
        expectedReadback: runtime.atcNav.expectedReadback || [],
        phaseReason: runtime.atcNav.phaseReason || null,
        lastAtcTransmission: runtime.atcNav.lastAtcTransmission || null
      }
    }
  });
});

app.post("/api/session/start", (req, res) => {
  const f = req.body || {};
  const session = startCoreSession(f);
  res.json({
    ok: true,
    session: session.navSession,
    legacySession: session.legacySession
  });
});

app.get("/api/session", (req, res) => {
  res.json({
    ok: true,
    session: {
      ...runtime.atcNav,
      legacy: getAtcSession()
    }
  });
});

app.post("/api/pilot/transmit", (req, res) => {
  const text = req.body?.text || req.body?.transcript || "";
  const result = respondToPilotTranscript(text, req.body || {});
  res.json({ ok: true, ...result });
});

app.post("/api/atc/respond", (req, res) => {
  const text = req.body?.text || req.body?.transcript || "";
  const result = respondToPilotTranscript(text, req.body || {});
  res.json({ ok: true, ...result });
});

app.post("/api/route/parse", (req, res) => {
  const route = req.body?.route || req.body?.text || "";
  const parsedLegacy = parseSimBriefLikeRoute(route);
  const parsedNav = parseFlightPlan({
    route,
    callsign: req.body?.callsign || runtime.atcNav.callsign,
    origin: req.body?.origin || req.body?.departure || runtime.atcNav.flightPlan?.origin,
    destination: req.body?.destination || req.body?.arrival || runtime.atcNav.flightPlan?.destination,
    sid: req.body?.sid || runtime.atcNav.flightPlan?.sid,
    star: req.body?.star || runtime.atcNav.flightPlan?.star,
    cruiseAltitude: req.body?.cruiseAltitude || runtime.atcNav.flightPlan?.cruiseAltitude
  });
  res.json({ ok: true, parsed: parsedLegacy, nav: parsedNav });
});

app.get("/api/fs2efb", async (req, res) => {
  const result = await pollFs2Efb();
  res.status(result.ok ? 200 : 502).json(result);
});

app.post("/api/fs2efb/ingest", async (req, res) => {
  const raw = typeof req.body === "string" ? safeJson(req.body) : req.body;
  const telemetry = normalizeFs2EfbTelemetry(raw);
  runtime.fs2efb.lastIngest = new Date().toISOString();
  const result = await handleTelemetry(telemetry);
  res.json({ ok: true, telemetry, ...result });
});

app.get("/api/telemetry/state", async (req, res) => {
  if (!runtime.fs2efb.lastData && FS2EFB_URL) await pollFs2Efb();

  res.json({
    ok: true,
    source: "fs2efb",
    lastPoll: runtime.fs2efb.lastPoll,
    lastIngest: runtime.fs2efb.lastIngest,
    lastError: runtime.fs2efb.lastError,
    telemetry: runtime.fs2efb.lastData,
    engine: runtime.atcNav
  });
});

app.get("/volanta/health", (req, res) => {
  res.json(getVolantaHealth({
    mode: VOLANTA_MODE,
    webhookUrl: VOLANTA_WEBHOOK_URL,
    apiUrl: VOLANTA_API_URL,
    apiKeyConfigured: Boolean(VOLANTA_API_KEY),
    fs2efbConfigured: Boolean(FS2EFB_URL)
  }));
});

app.post("/volanta/session/start", (req, res) => {
  const session = startVolantaSession(req.body || {});
  res.json({ ok: true, session });
});

app.post("/volanta/session/stop", (req, res) => {
  const session = stopVolantaSession(req.body || {});
  res.json({ ok: true, session });
});

app.get("/volanta/session", (req, res) => {
  res.json({ ok: true, session: getVolantaSession() });
});

app.get("/volanta/snapshot", (req, res) => {
  res.json({ ok: true, snapshot: buildVolantaSnapshot(runtime.fs2efb.lastData) });
});

app.get("/sayintentions/adapter/health", (req, res) => {
  res.json({
    ok: true,
    enabled: SAYINTENTIONS_ADAPTER_ENABLED,
    configured: Boolean(SAYINTENTIONS_SIMAPI_URL),
    lastForward: runtime.lastSayIntentionsForward
  });
});

app.get("/traffic-v2/health", (req, res) => {
  res.json({
    ok: true,
    service: "traffic-v2",
    version: VERSION,
    source: "skyecho-core-engine",
    fs2efbConfigured: Boolean(FS2EFB_URL),
    lastTelemetryPoll: runtime.fs2efb.lastPoll,
    lastTelemetryIngest: runtime.fs2efb.lastIngest,
    engine: {
      legacy: getEngineHealth(),
      nav: runtime.atcNav
    }
  });
});

app.get("/traffic-v2/state", async (req, res) => {
  if (!runtime.fs2efb.lastData && FS2EFB_URL) await pollFs2Efb();

  res.json({
    ok: true,
    source: "skyecho-core-engine",
    aircraftCount: runtime.fs2efb.lastData ? 1 : 0,
    aircraft: runtime.fs2efb.lastData ? [runtime.fs2efb.lastData] : [],
    engine: runtime.atcNav,
    lastError: runtime.fs2efb.lastError
  });
});

app.post("/traffic-v2/start", async (req, res) => {
  if (!runtime.atcNav.active || req.body?.route) {
    startCoreSession({
      callsign: req.body?.callsign || "AAL318",
      aircraft: req.body?.aircraft || "B738",
      origin: req.body?.origin || req.body?.airport || "",
      destination: req.body?.dest || req.body?.destination || "",
      route: req.body?.route || "",
      cruiseAltitude: req.body?.cruiseAltitude || "",
      runway: req.body?.runway || ""
    });
  }

  if (FS2EFB_URL) await pollFs2Efb();

  res.json({
    ok: true,
    running: true,
    source: "skyecho-core-engine",
    aircraftCount: runtime.fs2efb.lastData ? 1 : 0,
    radio: req.body?.userFrequency || runtime.fs2efb.lastData?.com1 || null,
    engine: runtime.atcNav
  });
});

app.post("/traffic-v2/stop", (req, res) => {
  res.json({ ok: true, running: false });
});

app.use((req, res) => {
  res.status(404).json({ ok: false, error: `Cannot ${req.method} ${req.path}` });
});

app.listen(PORT, () => {
  console.log(`SkyEchoCabin Core Engine v${VERSION} on ${PORT}`);
});
