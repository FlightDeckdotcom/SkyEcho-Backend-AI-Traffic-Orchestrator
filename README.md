# SkyEcho Backend v1.2 — Safe Boot + Lazy GitHub CSV NavData

This version fixes Render `Exited with status 134` by **not downloading/parsing the large GitHub CSV navdata during startup**.

It boots from small local starter CSV files first, then lets you sync GitHub navdata after the service is live.

## Render
Build Command:
```bash
corepack enable && yarn install
```
Start Command:
```bash
npm start
```

## Environment
```txt
NODE_VERSION=20.18.1
PORT=10000
BRIDGE_SECRET=choose_a_private_secret
DEFAULT_AIRPORT=TAPA
DEFAULT_DENSITY=3
NAVDATA_BASE_URL=https://raw.githubusercontent.com/FlightDeckdotcom/SKYECHOCABIN-Discord-Bot/main/data
PREFER_REMOTE_NAVDATA=false
```

Keep `PREFER_REMOTE_NAVDATA=false` for v1.2. Use `/data/sync` after startup.

## Test
```txt
/health
/data/status
```

## Sync GitHub CSV navdata
POST `/data/sync` with header `x-bridge-secret`.

Body:
```json
{ "mode":"boot" }
```

Boot mode loads a safe subset: airports, runways, frequencies, navaids, taxiways, aprons, ATS routes, designated points.

Full mode exists but should be used only after the backend is stable:
```json
{ "mode":"full", "timeoutMs": 12000, "maxBytes": 6000000 }
```
