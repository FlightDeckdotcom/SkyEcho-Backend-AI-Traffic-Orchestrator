// SkyEchoCabin Render Backend v6.9.54 UltraStrict
// FS2EFB + SimBrief + SkyEcho ATC core. Volanta is optional session/tracking layer.
// SayIntentions removed from core traffic dependency.

import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import {
  getVolantaHealth,
  getVolantaSession,
  startVolantaSession,
  stopVolantaSession,
  ingestVolantaTelemetry,
  buildVolantaSnapshot
} from "./src/connectors/volantaBridge.js";

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 10000;
const FS2EFB_URL = process.env.FS2EFB_URL || process.env.FS2EFB_ENDPOINT || "";
const SIMBRIEF_USER_ID = process.env.SIMBRIEF_USER_ID || process.env.SIMBRIEF_PILOT_ID || "";
const VOLANTA_MODE = process.env.VOLANTA_MODE || "standby";
const VOLANTA_WEBHOOK_URL = process.env.VOLANTA_WEBHOOK_URL || "";
const VOLANTA_API_URL = process.env.VOLANTA_API_URL || "";
const VOLANTA_API_KEY = process.env.VOLANTA_API_KEY || "";

const runtime = { fs2efb: { lastPoll: null, lastError: null, lastData: null } };

app.use("/frontend", express.static(path.join(__dirname, "frontend")));
app.use("/public", express.static(path.join(__dirname, "public")));
app.use("/assets", express.static(path.join(__dirname, "assets")));

function safeJson(text) { try { return JSON.parse(text); } catch { return { raw: text }; } }
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

function normalizeFs2EfbTelemetry(raw = {}) {
  const src = raw?.aircraft || raw?.telemetry || raw?.data || raw || {};
  const position = src.position || raw.position || {};
  return {
    source: "fs2efb",
    timestamp: new Date().toISOString(),
    callsign: src.callsign || src.callSign || src.flight || src.atc_id || raw.callsign || "",
    latitude: num(src.lat ?? src.latitude ?? position.lat ?? position.latitude),
    longitude: num(src.lon ?? src.lng ?? src.longitude ?? position.lon ?? position.lng ?? position.longitude),
    altitude: num(src.altitude ?? src.alt ?? src.baro_altitude ?? position.altitude),
    heading: num(src.heading ?? src.hdg ?? src.track),
    groundSpeed: num(src.groundSpeed ?? src.groundspeed ?? src.gs ?? src.speed),
    verticalSpeed: num(src.verticalSpeed ?? src.vs ?? src.vertical_speed),
    onGround: Boolean(src.onGround ?? src.simOnGround ?? src.ground),
    com1: src.com1 ?? src.com1Active ?? src.radio ?? null,
    transponder: src.squawk ?? src.transponder ?? null,
    raw
  };
}

async function pollFs2Efb() {
  if (!FS2EFB_URL) return { ok: false, error: "FS2EFB_URL/FS2EFB_ENDPOINT not configured." };
  try {
    const r = await fetch(FS2EFB_URL, { cache: "no-store" });
    const parsed = safeJson(await r.text());
    const telemetry = normalizeFs2EfbTelemetry(parsed);
    runtime.fs2efb.lastPoll = new Date().toISOString();
    runtime.fs2efb.lastError = null;
    runtime.fs2efb.lastData = telemetry;
    ingestVolantaTelemetry(telemetry, {
      mode: VOLANTA_MODE,
      webhookUrl: VOLANTA_WEBHOOK_URL,
      apiUrl: VOLANTA_API_URL,
      apiKey: VOLANTA_API_KEY
    }).catch(err => console.warn("Volanta ingest warning:", err.message));
    return { ok: true, telemetry };
  } catch (e) {
    runtime.fs2efb.lastError = e.message;
    return { ok: false, error: e.message };
  }
}

app.get("/", (req, res) => res.json({
  ok: true,
  service: "SkyEchoCabin Backend",
  version: "6.9.54",
  architecture: "FS2EFB + SimBrief + SkyEcho ATC Core + optional Volanta bridge",
  app: "/app/",
  volanta: "/volanta/health"
}));

app.get(["/app", "/app/"], (req, res) => {
  res.sendFile(path.join(__dirname, "frontend", "index.html"));
});

app.get("/health", (req, res) => res.json({
  ok: true,
  service: "skyecho-backend",
  version: "6.9.54",
  fs2efbConfigured: Boolean(FS2EFB_URL),
  simbriefConfigured: Boolean(SIMBRIEF_USER_ID),
  volantaMode: VOLANTA_MODE
}));

app.get("/api/fs2efb", async (req, res) => {
  const result = await pollFs2Efb();
  res.status(result.ok ? 200 : 502).json(result);
});

app.get("/api/telemetry/state", async (req, res) => {
  if (!runtime.fs2efb.lastData && FS2EFB_URL) await pollFs2Efb();
  res.json({
    ok: true,
    source: "fs2efb",
    lastPoll: runtime.fs2efb.lastPoll,
    lastError: runtime.fs2efb.lastError,
    telemetry: runtime.fs2efb.lastData
  });
});

app.get("/volanta/health", (req, res) => res.json(getVolantaHealth({
  mode: VOLANTA_MODE,
  webhookUrl: VOLANTA_WEBHOOK_URL,
  apiUrl: VOLANTA_API_URL,
  apiKeyConfigured: Boolean(VOLANTA_API_KEY),
  fs2efbConfigured: Boolean(FS2EFB_URL)
})));

app.post("/volanta/session/start", (req, res) => res.json({ ok: true, session: startVolantaSession(req.body || {}) }));
app.post("/volanta/session/stop", (req, res) => res.json({ ok: true, session: stopVolantaSession(req.body || {}) }));
app.get("/volanta/session", (req, res) => res.json({ ok: true, session: getVolantaSession() }));

app.get("/volanta/snapshot", async (req, res) => {
  if (!runtime.fs2efb.lastData && FS2EFB_URL) await pollFs2Efb();
  res.json({ ok: true, snapshot: buildVolantaSnapshot(runtime.fs2efb.lastData) });
});

app.post("/volanta/telemetry", async (req, res) => {
  const result = await ingestVolantaTelemetry(req.body || {}, {
    mode: VOLANTA_MODE,
    webhookUrl: VOLANTA_WEBHOOK_URL,
    apiUrl: VOLANTA_API_URL,
    apiKey: VOLANTA_API_KEY
  });
  res.json({ ok: true, result });
});

app.get("/traffic-v2/health", (req, res) => res.json({
  ok: true,
  service: "traffic-v2",
  version: "6.9.54",
  source: "skyecho-fs2efb",
  sayIntentionsCoreRemoved: true,
  fs2efbConfigured: Boolean(FS2EFB_URL),
  volantaMode: VOLANTA_MODE,
  lastTelemetryPoll: runtime.fs2efb.lastPoll,
  lastError: runtime.fs2efb.lastError
}));

app.get("/traffic-v2/state", async (req, res) => {
  const fs = await pollFs2Efb();
  res.json({
    ok: true,
    source: "skyecho-fs2efb",
    aircraftCount: fs.ok && fs.telemetry ? 1 : 0,
    aircraft: fs.ok && fs.telemetry ? [fs.telemetry] : [],
    telemetry: fs.telemetry || null,
    lastError: fs.error || null
  });
});

app.post("/traffic-v2/start", async (req, res) => {
  const fs = await pollFs2Efb();
  res.json({
    ok: true,
    running: true,
    source: "skyecho-fs2efb",
    aircraftCount: fs.ok && fs.telemetry ? 1 : 0,
    radio: req.body?.userFrequency || fs.telemetry?.com1 || null
  });
});

app.post("/traffic-v2/stop", (req, res) => res.json({ ok: true, running: false }));

app.use((req, res) => res.status(404).json({
  ok: false,
  error: `Cannot ${req.method} ${req.path}`,
  hint: "Use /health, /api/fs2efb, /volanta/health, /volanta/session, /volanta/snapshot, or /traffic-v2/state."
}));

app.listen(PORT, () => console.log(`SkyEchoCabin v6.9.54 backend on ${PORT}`));
