// SkyEchoCabin Render backend v6.9.52
// Serves /app/ and provides Traffic v2 compatibility routes so the frontend stops 404ing.
// Fix: SayIntentions traffic endpoints that require api_key now receive api_key in the query string.
// Synthetic/ADSB traffic remains disabled.

import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';

const app = express();

app.use(cors());
app.use(express.json({ limit: '2mb' }));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 10000;

const FS2EFB_URL =
  process.env.FS2EFB_URL ||
  process.env.FS2EFB_ENDPOINT ||
  '';

const SAYINTENTIONS_TRAFFIC_URL =
  process.env.SAYINTENTIONS_TRAFFIC_URL ||
  '';

const SAYINTENTIONS_API_KEY =
  process.env.SAYINTENTIONS_API_KEY ||
  '';

const runtimeState = {
  trafficRunning: false,
  lastStartPayload: null,
  lastTrafficPoll: null,
  lastError: null,
  lastRawTrafficShape: null,
  traffic: [],
  radio: null
};

app.use('/frontend', express.static(path.join(__dirname, 'frontend')));
app.use('/public', express.static(path.join(__dirname, 'public')));
app.use('/assets', express.static(path.join(__dirname, 'assets')));

function normalizeTranscript(raw = '') {
  let t = String(raw || '').trim().toLowerCase();

  const repl = [
    [/alpha\s+november\s+uniform/g, 'anu'],
    [/golf\s+six\s+three\s+three/g, 'g633'],
    [/golf\s+633/g, 'g633'],
    [/gulf\s+six\s+three\s+three/g, 'g633'],
    [/gulf\s+633/g, 'g633'],
    [/flight\s+level\s+/g, 'fl'],
    [/five\s+thousand/g, '5000'],
    [/one\s+zero\s+zero/g, '100'],
    [/three\s+four\s+zero/g, '340'],
    [/zero\s+seven/g, '07'],
    [/zero\s+niner/g, '09'],
    [/niner/g, '9']
  ];

  for (const [a, b] of repl) {
    t = t.replace(a, b);
  }

  return t.replace(/\s+/g, ' ').trim();
}

function classify(raw, state = {}) {
  const text = normalizeTranscript(raw);

  const airwayRe =
    /\b([a-z]{1,2}\d{1,4}[a-z]?)\b/i;

  const namedFixRe =
    /\b(anu|gabar|dande|zpata|fredy|fredy2|eteck|mzulo|airow|copes|rbv|gve)\b/i;

  const routeReportRe =
    /\b(report|passing|abeam|over|crossing|established on|joining|intercepting|tracking|level)\b/i;

  // IMPORTANT:
  // Prevent "established on G633" from being classified as approach established.
  const trueApproachRe =
    /\b(established\s+(ils|rnav|localizer|loc|vor|ndb|visual|final)|on\s+(ils|rnav|localizer|loc|vor|ndb|visual)\s+(runway|approach)|glideslope|glidepath|final runway|established.*runway)\b/i;

  const checkinRe =
    /\b(with you|checking in|check in|passing|climbing through|descending through|level)\b/i;

  const readbackRe =
    /\b(cleared|clearance|taxi|hold short|line up|takeoff|land|climb|descend|maintain|turn|heading|direct|proceed|squawk|contact|frequency|expect|altimeter|push|start)\b/i;

  const hasAirwayOrFix =
    airwayRe.test(text) || namedFixRe.test(text);

  const isRouteReport =
    routeReportRe.test(text) && hasAirwayOrFix;

  const isTrueApproach =
    trueApproachRe.test(text);

  const hasReadback =
    readbackRe.test(text);

  const isCheckin =
    checkinRe.test(text) &&
    !hasReadback &&
    !isRouteReport;

  let intent = 'unknown';

  // PRIORITY ORDER MATTERS
  if (isRouteReport) {
    intent = 'route_position_report';
  } else if (isTrueApproach) {
    intent = 'approach_established';
  } else if (isCheckin) {
    intent = 'controller_checkin';
  } else if (hasReadback) {
    intent = 'instruction_readback';
  } else if (/clearance|ifr/.test(text)) {
    intent = 'request_clearance';
  }

  return {
    raw,
    text,
    intent,
    phase: state.phase || '',
    controller: state.controller || '',
    protected: {
      airwayRouteReportGuard: isRouteReport,
      trueApproachGuard: isTrueApproach
    }
  };
}

function buildSayIntentionsUrl(inputUrl) {
  const target = new URL(inputUrl);

  // CRITICAL FIX:
  // SayIntentions requires api_key in query string.
  if (
    SAYINTENTIONS_API_KEY &&
    !target.searchParams.has('api_key')
  ) {
    target.searchParams.set(
      'api_key',
      SAYINTENTIONS_API_KEY
    );
  }

  return target.toString();
}

async function fetchTextWithOptionalAuth(
  url,
  options = {}
) {
  const useApiKeyParam =
    options.useApiKeyParam !== false;

  const finalUrl =
    useApiKeyParam
      ? buildSayIntentionsUrl(url)
      : url;

  const headers = {};

  if (SAYINTENTIONS_API_KEY) {
    headers.Authorization =
      'Bearer ' + SAYINTENTIONS_API_KEY;

    headers['x-api-key'] =
      SAYINTENTIONS_API_KEY;
  }

  const r = await fetch(finalUrl, {
    headers,
    cache: 'no-store'
  });

  const text = await r.text();

  return {
    status: r.status,
    ok: r.ok,
    contentType:
      r.headers.get('content-type') ||
      'application/json',
    text
  };
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function extractTrafficArray(parsed) {
  if (Array.isArray(parsed)) {
    return parsed;
  }

  const candidates = [
    parsed?.traffic,
    parsed?.aircraft,
    parsed?.targets,
    parsed?.planes,
    parsed?.data,
    parsed?.results,
    parsed?.flights,
    parsed?.state?.traffic,
    parsed?.state?.aircraft,
    parsed?.response?.traffic,
    parsed?.response?.aircraft
  ];

  for (const c of candidates) {
    if (Array.isArray(c)) {
      return c;
    }
  }

  return [];
}

async function pollSayIntentionsTraffic() {
  if (!SAYINTENTIONS_TRAFFIC_URL) {
    return {
      connected: false,
      traffic: [],
      message:
        'No SAYINTENTIONS_TRAFFIC_URL configured.'
    };
  }

  const result =
    await fetchTextWithOptionalAuth(
      SAYINTENTIONS_TRAFFIC_URL,
      { useApiKeyParam: true }
    );

  const parsed = safeJson(result.text);

  const traffic =
    extractTrafficArray(parsed);

  runtimeState.traffic =
    Array.isArray(traffic)
      ? traffic
      : [];

  runtimeState.lastTrafficPoll =
    new Date().toISOString();

  runtimeState.lastRawTrafficShape = {
    isArray: Array.isArray(parsed),
    keys:
      parsed &&
      typeof parsed === 'object'
        ? Object.keys(parsed).slice(0, 20)
        : [],
    count: runtimeState.traffic.length
  };

  if (!result.ok) {
    runtimeState.lastError =
      parsed?.error ||
      `SayIntentions HTTP ${result.status}`;
  } else {
    runtimeState.lastError = null;
  }

  return {
    connected: true,
    status: result.status,
    traffic: runtimeState.traffic,
    raw: parsed
  };
}

app.get('/', (req, res) => {
  res.json({
    ok: true,
    service: 'SkyEchoCabin Render Backend',
    version: '6.9.52',
    app: '/app/',
    trafficV2: '/traffic-v2/health'
  });
});

app.get(
  ['/app', '/app/'],
  (req, res) => {
    res.sendFile(
      path.join(
        __dirname,
        'frontend',
        'index.html'
      )
    );
  }
);

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'skyecho-render-backend',
    version: '6.9.52'
  });
});

app.post(
  '/api/intent/classify',
  (req, res) => {
    res.json(
      classify(
        req.body?.text || '',
        req.body?.state || {}
      )
    );
  }
);

app.get(
  '/api/fs2efb',
  async (req, res) => {
    const url =
      req.query.url || FS2EFB_URL;

    if (!url) {
      return res.status(400).json({
        error:
          'Missing FS2EFB_URL/FS2EFB_ENDPOINT or ?url='
      });
    }

    try {
      const r = await fetch(url, {
        cache: 'no-store'
      });

      const text = await r.text();

      res
        .type(
          r.headers.get('content-type') ||
            'application/json'
        )
        .status(r.status)
        .send(text);
    } catch (e) {
      res.status(502).json({
        error: e.message
      });
    }
  }
);

app.get(
  '/api/sayintentions/traffic',
  async (req, res) => {
    const url =
      req.query.url ||
      SAYINTENTIONS_TRAFFIC_URL;

    if (!url) {
      return res.status(400).json({
        error:
          'Missing SAYINTENTIONS_TRAFFIC_URL or ?url='
      });
    }

    try {
      const r =
        await fetchTextWithOptionalAuth(
          url,
          { useApiKeyParam: true }
        );

      res
        .type(r.contentType)
        .status(r.status)
        .send(r.text);
    } catch (e) {
      res.status(502).json({
        error: e.message
      });
    }
  }
);

// Traffic v2 routes
app.get(
  '/traffic-v2/health',
  (req, res) => {
    res.json({
      ok: true,
      service: 'traffic-v2',
      version: '6.9.52',
      running:
        runtimeState.trafficRunning,
      sayIntentionsConfigured:
        Boolean(
          SAYINTENTIONS_TRAFFIC_URL &&
          SAYINTENTIONS_API_KEY
        ),
      fs2efbConfigured:
        Boolean(FS2EFB_URL),
      lastTrafficPoll:
        runtimeState.lastTrafficPoll,
      lastError:
        runtimeState.lastError,
      lastRawTrafficShape:
        runtimeState.lastRawTrafficShape
    });
  }
);

app.get(
  '/traffic-v2/state',
  async (req, res) => {
    try {
      const live =
        SAYINTENTIONS_TRAFFIC_URL
          ? await pollSayIntentionsTraffic()
          : null;

      const aircraft =
        live?.traffic ||
        runtimeState.traffic ||
        [];

      res.json({
        ok: true,
        running:
          runtimeState.trafficRunning,
        source:
          SAYINTENTIONS_TRAFFIC_URL
            ? 'sayintentions'
            : 'standby',
        traffic: aircraft,
        aircraft,
        aircraftCount:
          aircraft.length,
        radio:
          runtimeState.radio,
        lastStartPayload:
          runtimeState.lastStartPayload,
        lastTrafficPoll:
          runtimeState.lastTrafficPoll,
        lastRawTrafficShape:
          runtimeState.lastRawTrafficShape,
        lastError:
          runtimeState.lastError
      });
    } catch (e) {
      runtimeState.lastError =
        e.message;

      res.status(502).json({
        ok: false,
        error: e.message,
        traffic:
          runtimeState.traffic || [],
        aircraft:
          runtimeState.traffic || [],
        aircraftCount:
          runtimeState.traffic?.length || 0
      });
    }
  }
);

app.get(
  '/traffic-v2/adsb',
  (req, res) => {
    res.json({
      ok: true,
      source: 'disabled',
      aircraft: [],
      message:
        'Synthetic/ADSB traffic disabled. Use SayIntentions traffic connector.'
    });
  }
);

app.post(
  '/traffic-v2/start',
  async (req, res) => {
    runtimeState.trafficRunning = true;

    runtimeState.lastStartPayload =
      req.body || {};

    runtimeState.radio =
      runtimeState.lastStartPayload
        ?.userFrequency || null;

    let aircraftCount =
      runtimeState.traffic.length;

    try {
      if (
        SAYINTENTIONS_TRAFFIC_URL
      ) {
        const live =
          await pollSayIntentionsTraffic();

        aircraftCount =
          live.traffic?.length || 0;
      }
    } catch (e) {
      runtimeState.lastError =
        e.message;
    }

    res.json({
      ok: true,
      running: true,
      aircraftCount,
      radio: runtimeState.radio,
      message:
        'Traffic v2 started.'
    });
  }
);

app.post(
  '/traffic-v2/stop',
  (req, res) => {
    runtimeState.trafficRunning = false;

    res.json({
      ok: true,
      running: false
    });
  }
);

app.post(
  '/traffic-v2/audio-finished',
  (req, res) => {
    res.json({
      ok: true,
      accepted: true
    });
  }
);

app.post(
  '/traffic-v2/inject',
  (req, res) => {
    const item = req.body || {};

    runtimeState.traffic = [
      item,
      ...runtimeState.traffic
    ].slice(0, 50);

    res.json({
      ok: true,
      traffic: runtimeState.traffic,
      aircraftCount:
        runtimeState.traffic.length
    });
  }
);

app.get(
  '/traffic-v2/debug',
  async (req, res) => {
    const out = {
      ok: true,
      sayIntentionsConfigured:
        Boolean(
          SAYINTENTIONS_TRAFFIC_URL &&
          SAYINTENTIONS_API_KEY
        ),
      fs2efbConfigured:
        Boolean(FS2EFB_URL),
      lastError:
        runtimeState.lastError,
      lastRawTrafficShape:
        runtimeState.lastRawTrafficShape
    };

    try {
      if (
        SAYINTENTIONS_TRAFFIC_URL
      ) {
        const live =
          await pollSayIntentionsTraffic();

        out.sayIntentions = {
          status: live.status,
          aircraftCount:
            live.traffic?.length || 0,
          sample:
            live.traffic?.slice(0, 3) || []
        };
      }
    } catch (e) {
      out.sayIntentions = {
        error: e.message
      };
    }

    res.json(out);
  }
);

app.use((req, res) => {
  res.status(404).json({
    ok: false,
    error:
      `Cannot ${req.method} ${req.path}`,
    hint:
      'Use /app/, /health, /traffic-v2/health, /traffic-v2/state, or /traffic-v2/debug.'
  });
});

app.listen(PORT, () => {
  console.log(
    `SkyEcho UltraStrict backend on ${PORT}`
  );
});
