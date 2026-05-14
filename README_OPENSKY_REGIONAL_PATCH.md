# SkyEchoCabin Traffic v2 OpenSky + Regional Governance Patch

## Files to upload

```text
src/traffic-v2/OpenSkyTokenManager.js
src/traffic-v2/OpenSkyLiveProvider.js
src/traffic-v2/OpenSkyTrafficV2Integration.js
src/traffic-v2/registerOpenSkyTrafficV2Routes.js
src/governance/RegionalRuleManager.js
config/regional_governance_notes.json
```

## Patch src/traffic-v2/registerTrafficV2Routes.js

Add near the top:

```js
const { installOpenSkyIntoTrafficWorld } = require('./OpenSkyTrafficV2Integration');
const { registerOpenSkyTrafficV2Routes } = require('./registerOpenSkyTrafficV2Routes');
```

After `const trafficV2 = new TrafficWorld(...)`, add:

```js
installOpenSkyIntoTrafficWorld(trafficV2);
registerOpenSkyTrafficV2Routes({ app, requireSecret, trafficV2 });
```

## Render environment variables

```text
OPENSKY_ENABLED=true
OPENSKY_CLIENT_ID=your_client_id
OPENSKY_CLIENT_SECRET=your_client_secret
OPENSKY_RADIUS_NM=50
OPENSKY_POLL_MS=30000
OPENSKY_MAX_AIRCRAFT=20
OPENSKY_STALE_MS=180000
```

## Test

```bash
curl -X POST "https://skyecho-backend-ai-traffic-orchestrator.onrender.com/traffic-v2/opensky/sync" \
  -H "Content-Type: application/json" \
  -H "x-bridge-secret: choose_a_private_secret" \
  -d '{
    "lat": 17.3112,
    "lon": -62.7187,
    "airport": "TKPK",
    "origin": "TKPK",
    "dest": "TAPA",
    "runway": "07",
    "route": "SKB G633 ANU",
    "radiusNm": 50,
    "frequency": "119.10"
  }'
```

Then open:

```text
/traffic-v2/opensky/status
/traffic-v2/state
/traffic-v2/adsb
```

## Notes

OpenSky is only a live aircraft seed source. SkyEchoCabin still creates the AI radio behavior and Piper TTS transmissions through Traffic v2.

The FAA AIP and EUROCONTROL eAIP files are governance/reference inputs, not full procedure databases. Use FAA CIFP/NASR, State AIXM/eAIP exports, Navigraph-style datasets, or your procedure CSVs for exact SID/STAR/IAP waypoint restrictions.
