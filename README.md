# SkyEcho Backend v1 — AI Traffic Orchestrator

This backend moves AI traffic authority out of the SkyEchoCabin browser and into a central service.

## What it fixes

- AI traffic no longer belongs in the frontend.
- Squawk codes are assigned only on IFR/VFR initial clearance / flight following, not takeoff or landing.
- Runway use is reserved by the backend before takeoff/landing clearances.
- Arrival and ground sequencing now have backend-owned modules.
- Callsigns are formatted with aviation digit phraseology: `BWA268` → `Caribbean Airlines two six eight`.
- ADS-B style telemetry is streamed over WebSocket.

## Files

```text
src/index.js                         Express + WebSocket API
src/traffic/TrafficOrchestrator.js   AI aircraft lifecycle
src/separation/RunwaySequencer.js    runway reservations
src/separation/ArrivalSequencer.js   arrival queues
src/separation/GroundSequencer.js    taxi conflict placeholder
src/atc/CallsignFormatter.js         aviation callsign phraseology
src/atc/IntentResolver.js            route vs ILS/final separation + taxi-in intents
src/atc/Phraseology.js               ATC phrase builder
data/*.csv                           CSV world data
frontend/skyecho_backend_v1_frontend_patch.js optional UI connector patch
```

## Render deployment

Create a new **Web Service** on Render.

Recommended settings:

```text
Root Directory: backend or repository root, depending where you upload these files
Build Command: npm install
Start Command: npm start
Environment:
  NODE_VERSION=20.18.1
  PORT=10000
  BRIDGE_SECRET=your_private_secret
  DEFAULT_AIRPORT=TKPK
  DEFAULT_DENSITY=3
```

If you upload this folder as the repo root, leave Root Directory blank.

## API

```text
GET  /health
GET  /traffic/state
GET  /traffic/adsb
GET  /traffic/logs
POST /traffic/start      header: x-bridge-secret
POST /traffic/stop       header: x-bridge-secret
POST /traffic/pilot-event header: x-bridge-secret
WS   /ws
```

## Example start

```bash
curl -X POST https://YOUR-BACKEND.onrender.com/traffic/start \
  -H 'Content-Type: application/json' \
  -H 'x-bridge-secret: YOUR_SECRET' \
  -d '{"airport":"TKPK","density":3}'
```

## Frontend connection

Paste the contents of `frontend/skyecho_backend_v1_frontend_patch.js` before `</body>` in the working SkyEchoCabin HTML, or use it as a separate script tag if your hosting supports it.

It adds a floating **SkyEcho Backend AI Engine** panel with:

- Backend URL
- Secret
- Start Backend Traffic
- Stop Traffic
- Pilot event test
- WebSocket logs

## Next steps for full production

1. Replace sample CSV with your GitHub CSV files.
2. Add real taxiway node graph and A-star pathfinding.
3. Add PostGIS/H3 spatial indexing for global 100 NM traffic bubbles.
4. Move Piper/voice routing into a dedicated voice service.
5. Keep Discord as audio bridge only.
