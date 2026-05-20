# SkyEchoCabin Volanta Bridge v6.9.54 UltraStrict

Use FS2EFB as source of truth. Volanta is optional session/tracking/logging.

Copy these files into your repo:

- server.js
- package.json
- src/connectors/volantaBridge.js
- tests/volanta_bridge.test.mjs

Render env:

FS2EFB_URL=http://your-fs2efb-endpoint
SIMBRIEF_USER_ID=your_simbrief_id
VOLANTA_MODE=standby
VOLANTA_WEBHOOK_URL=
VOLANTA_API_URL=
VOLANTA_API_KEY=

Routes:

GET /volanta/health
POST /volanta/session/start
POST /volanta/session/stop
GET /volanta/session
GET /volanta/snapshot
POST /volanta/telemetry
GET /api/fs2efb
GET /traffic-v2/health
GET /traffic-v2/state
