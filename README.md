# SkyEchoCabin Core Engine v6.9.57 UltraStrict

Architecture:
FS2EFB telemetry + SimBrief route/OFP + procedure/nav data + protected ATC state machine + aviation parser + route/phase validation + phraseology engine + optional Volanta/SayIntentions adapters.

Replace/add these files in your repo. Keep SayIntentions optional, never core.

Render env:
FS2EFB_URL=
SIMBRIEF_USER_ID=
VOLANTA_MODE=standby
SAYINTENTIONS_ADAPTER_ENABLED=false
SAYINTENTIONS_SIMAPI_URL=
SAYINTENTIONS_API_KEY=

Routes:
GET /health
POST /api/session/start
POST /api/pilot/transmit
POST /api/fs2efb/ingest
GET /traffic-v2/state
GET /sayintentions/adapter/health

Test: npm test
