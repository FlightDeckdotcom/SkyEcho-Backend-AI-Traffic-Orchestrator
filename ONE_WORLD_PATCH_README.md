# SkyEcho Backend v1.4 — One-World Traffic/ATC Authority Patch

This patch fixes the AI traffic world so it behaves as one shared SkyEcho ATC world instead of a separate background script.

## Fixes

- Excludes the user's callsign from AI traffic spawning.
- Default protected callsigns: `BWA268,N23566`. Override with `USER_CALLSIGNS`.
- Adds `/traffic/user-state` so the frontend/bridge can tell the backend the active user aircraft.
- `/traffic/pilot-event` now registers the user aircraft and pauses AI radio briefly.
- `/bridge/event` now understands PTT/transmit events and pauses AI radio while the user is transmitting.
- AI radio queue respects user priority, so AI traffic and ATC should not speak over the user's PTT/readback.
- Start traffic accepts `userCallsign`, `origin`, `dest`, and `runway` to bind AI traffic into the same world.

## Recommended Render Environment

```txt
ONE_WORLD_MODE=true
USER_CALLSIGNS=BWA268,N23566
USER_PRIORITY_HOLD_MS=9000
USER_PTT_HOLD_MS=4500
RADIO_MIN_GAP_MS=11000
MAX_TRAFFIC_DENSITY=2
PIPER_ENABLED=true
```

## Required frontend companion

Use the v6.4 frontend patch or send equivalent events:

```json
POST /traffic/user-state
{ "callsign":"BWA268", "airport":"TAPA", "pttActive":true, "holdMs":4500 }
```

During PTT, the backend holds AI traffic transmissions so the user's SkyEcho ATC conversation stays first.
