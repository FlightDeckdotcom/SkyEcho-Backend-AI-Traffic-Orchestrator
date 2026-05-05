# SkyEcho Backend v1.1 AI Traffic Orchestrator

This version can load the public GitHub CSV nav-data from:

`https://github.com/FlightDeckdotcom/SKYECHOCABIN-Discord-Bot/tree/main/data`

Default raw base URL:

`https://raw.githubusercontent.com/FlightDeckdotcom/SKYECHOCABIN-Discord-Bot/main/data`

## Render settings

Build command:

```bash
corepack enable && yarn install
```

Start command:

```bash
npm start
```

Environment:

```txt
NODE_VERSION=20.18.1
PORT=10000
BRIDGE_SECRET=choose_a_private_secret
DEFAULT_AIRPORT=TAPA
DEFAULT_DENSITY=3
NAVDATA_BASE_URL=https://raw.githubusercontent.com/FlightDeckdotcom/SKYECHOCABIN-Discord-Bot/main/data
PREFER_REMOTE_NAVDATA=true
```

## Test endpoints

```txt
/health
/data/status
/traffic/state
/traffic/adsb
```

`/data/status` confirms how many rows loaded from each CSV file.
