# SkyEcho Backend v2.0 OpenSky REST Seed Mode

This patch keeps SkyEchoCabin as the ATC authority and uses OpenSky only as a lightweight real-world traffic seed.

## Behavior

- Pulls OpenSky `/states/all` with small route/airport bounding boxes.
- Keeps only 3–7 relevant aircraft in the user session.
- Falls back to procedural SkyEcho traffic when OpenSky returns nothing, fails, or hits limits.
- Caches route snapshots for 10–30 minutes to keep usage free-friendly.
- AI aircraft still request through the SkyEchoCabin ATC bridge before readback/audio.

## Recommended Render Environment

```txt
TRAFFIC_SOURCE=opensky_seeded
OPENSKY_ENABLED=true
OPENSKY_MODE=session_seed
OPENSKY_MAX_CALLS_PER_SESSION=3
OPENSKY_CACHE_TTL_MS=1800000
OPENSKY_MAX_AIRCRAFT=7
OPENSKY_ROUTE_BUBBLE_NM=80
OPENSKY_MAX_BOX_DEG2=25
FALLBACK_PROCEDURAL_TRAFFIC=true

# Optional authenticated OpenSky access
OPENSKY_CLIENT_ID=
OPENSKY_CLIENT_SECRET=

AI_ATC_BRIDGE_REQUIRED=true
ALLOW_AI_PILOT_REQUESTS=true
AI_PILOT_READBACK_ONLY=false
TRAFFIC_ATC_AUDIO=false
AI_PILOT_AUDIO=true
PIPER_ENABLED=true
DROP_TRAFFIC_AUDIO_DURING_USER_PRIORITY=false
```

## New endpoint

`GET /opensky/status` shows OpenSky mode, cache/limits, and last seed status.

## Notes

OpenSky does not control ATC. It only provides aircraft snapshot data. SkyEchoCabin still controls clearances, runway sequencing, and radio.
