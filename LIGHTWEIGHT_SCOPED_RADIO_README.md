# SkyEcho Backend v1.6 — Lightweight Scoped Radio Traffic World

This patch keeps SkyEchoCabin stable by changing backend AI traffic from a heavy always-running world into a lightweight scoped radio-world.

## Main rules

- Only 3-7 AI aircraft exist in a user session.
- Traffic is scoped to the user's loaded flight plan airports and active airport/frequency.
- Every 20-45 seconds the backend chooses one valid nearby AI aircraft, advances its phase, and emits one realistic pilot transmission.
- Backend ATC/controller audio remains internal only. Main SkyEchoCabin ATC remains the only audible controller.
- Piper WAVs are generated only when a line is actually being played.
- WAVs are deleted after playback window, any WAV older than 60 seconds is cleaned, and the backend never keeps more than 10 WAVs.
- Radio queue is capped so stale traffic cannot pile up.
- Traffic auto-pauses when no frontend clients are connected.
- Remote CSV sync can be limited to the user's flight-plan airports instead of storing the full world in memory.

## Recommended Render environment

```txt
ONE_WORLD_MODE=true
TRAFFIC_ATC_AUDIO=false
AI_PILOT_AUDIO=true
DROP_TRAFFIC_AUDIO_DURING_USER_PRIORITY=true

AI_SESSION_AIRCRAFT_MIN=3
AI_SESSION_AIRCRAFT_MAX=7
MAX_TRAFFIC_DENSITY=7
MAX_RADIO_QUEUE=8
RADIO_EVENT_MIN_MS=20000
RADIO_EVENT_MAX_MS=45000
RADIO_MIN_GAP_MS=13000
AI_PHASE_SCALE=4

AUDIO_RETENTION_MS=60000
MAX_AUDIO_FILES=10
AUTO_PAUSE_NO_CLIENTS=true
SCOPED_TRAFFIC_ONLY=true

PIPER_ENABLED=true
USER_CALLSIGNS=BWA268,N23566
USER_PRIORITY_HOLD_MS=15000
USER_PTT_HOLD_MS=8000
```

## Start traffic payload

The frontend/backend panel should include the user's flight plan where available:

```json
{
  "airport": "TAPA",
  "origin": "TAPA",
  "dest": "TKPK",
  "route": "ANU G633 SKB",
  "userCallsign": "BWA268",
  "density": 5
}
```

The backend will scope traffic to TAPA, TKPK, ANU, and SKB where available.

## Data sync memory saving

To load only scoped airport nav rows, call `/data/sync` with:

```json
{
  "mode": "boot",
  "airports": ["TAPA", "TKPK", "ANU", "SKB"]
}
```
