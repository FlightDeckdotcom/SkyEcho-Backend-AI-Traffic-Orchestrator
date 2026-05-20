// SkyEchoCabin UltraStrict backend proxy v6.9.49
// Serves /app, proxies FS2EFB/SayIntentions, and exposes ATC parser classification tests.

import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 10000;
const FS2EFB_URL = process.env.FS2EFB_URL || "";
const SAYINTENTIONS_TRAFFIC_URL = process.env.SAYINTENTIONS_TRAFFIC_URL || "";
const SAYINTENTIONS_API_KEY = process.env.SAYINTENTIONS_API_KEY || "";

app.use("/frontend", express.static(path.join(__dirname, "frontend")));
app.use("/public", express.static(path.join(__dirname, "public")));

function normalizeTranscript(raw = "") {
  let t = String(raw || "").trim().toLowerCase();

  const repl = [
    [/alpha\s+november\s+uniform/g, "anu"],
    [/golf\s+six\s+three\s+three/g, "g633"],
    [/golf\s+633/g, "g633"],
    [/gulf\s+six\s+three\s+three/g, "g633"],
    [/gulf\s+633/g, "g633"],
    [/flight\s+level\s+/g, "fl"],
    [/five\s+thousand/g, "5000"],
    [/one\s+zero\s+zero/g, "100"],
    [/three\s+four\s+zero/g, "340"]
  ];

  for (const [a, b] of repl) t = t.replace(a, b);
  return t.replace(/\s+/g, " ").trim();
}

function classify(raw, state = {}) {
  const text = normalizeTranscript(raw);

  const airwayRe = /\b([a-z]{1,2}\d{1,4}[a-z]?)\b/i;
  const namedFixRe = /\b(anu|gabar|dande|zpata|fredy|fredy2)\b/i;

  const routeReportRe =
    /\b(report|passing|abeam|over|crossing|established on|joining|intercepting|tracking|level)\b/i;

  const trueApproachRe =
    /\b(established\s+(ils|rnav|localizer|loc|vor|ndb|visual|final)|on\s+(ils|rnav|localizer|loc|vor|ndb|visual)\s+(runway|approach)|glideslope|glidepath|final runway)\b/i;

  const checkinRe =
    /\b(with you|checking in|check in|passing|climbing through|descending through|level)\b/i;

  const readbackRe =
    /\b(cleared|clearance|taxi|hold short|line up|takeoff|land|climb|descend|maintain|turn|heading|direct|proceed|squawk|contact|frequency|expect|altimeter|push|start)\b/i;

  const hasAirwayOrFix = airwayRe.test(text) || namedFixRe.test(text);
  const isRouteReport = routeReportRe.test(text) && hasAirwayOrFix;
  const isTrueApproach = trueApproachRe.test(text);

  const hasReadback = readbackRe.test(text);
  const isCheckin = checkinRe.test(text) && !hasReadback && !isRouteReport;

  let intent = "unknown";

  // Priority guard: airway route reports win over generic “established”
  if (isRouteReport) intent = "route_position_report";
  else if (isTrueApproach) intent = "approach_established";
  else if (isCheckin) intent = "controller_checkin";
  else if (hasReadback) intent = "instruction_readback";
  else if (/clearance|ifr/.test(text)) intent = "request_clearance";

  return {
    raw,
    text,
    intent,
    phase: state.phase || "",
    controller: state.controller || "",
    protected: {
      airwayRouteReportGuard: isRouteReport,
      trueApproachGuard: isTrueApproach
    }
  };
}

app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "SkyEchoCabin UltraStrict Backend",
    version: "6.9.49",
    app: "/app/"
  });
});

app.get("/app", (req, res) => {
  res.sendFile(path.join(__dirname, "frontend", "index.html"));
});

app.get("/app/", (req, res) => {
  res.sendFile(path.join(__dirname, "frontend", "index.html"));
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "skyecho-ultrastrict-backend",
    version: "6.9.49"
  });
});

app.post("/api/intent/classify", (req, res) => {
  res.json(classify(req.body?.text || "", req.body?.state || {}));
});

app.get("/api/fs2efb", async (req, res) => {
  const url = req.query.url || FS2EFB_URL;
  if (!url) return res.status(400).json({ error: "Missing FS2EFB_URL or ?url=" });

  try {
    const r = await fetch(url, { cache: "no-store" });
    const text = await r.text();
    res.type(r.headers.get("content-type") || "application/json").send(text);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.get("/api/sayintentions/traffic", async (req, res) => {
  const url = req.query.url || SAYINTENTIONS_TRAFFIC_URL;
  if (!url) {
    return res.status(400).json({
      error: "Missing SAYINTENTIONS_TRAFFIC_URL or ?url="
    });
  }

  try {
    const headers = {};
    if (SAYINTENTIONS_API_KEY) headers.Authorization = "Bearer " + SAYINTENTIONS_API_KEY;

    const r = await fetch(url, { headers, cache: "no-store" });
    const text = await r.text();

    res.type(r.headers.get("content-type") || "application/json").send(text);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`SkyEcho UltraStrict backend on ${PORT}`);
});
