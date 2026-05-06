# SkyEcho Backend v1.5 Single-Controller World Patch

This patch fixes the duplicate-controller problem.

Rules:
- AI traffic pilot transmissions may be audible.
- Backend ATC responses for AI traffic are internal/sequencing only by default.
- The audible controller channel belongs to the main SkyEchoCabin ATC engine.
- User callsigns are excluded from AI spawn.
- AI radio is dropped/held during user PTT/priority windows.

Recommended Render env:

```txt
ONE_WORLD_MODE=true
TRAFFIC_ATC_AUDIO=false
AI_PILOT_AUDIO=true
DROP_TRAFFIC_AUDIO_DURING_USER_PRIORITY=true
USER_CALLSIGNS=BWA268,N23566
USER_PRIORITY_HOLD_MS=12000
USER_PTT_HOLD_MS=6500
RADIO_MIN_GAP_MS=13000
MAX_TRAFFIC_DENSITY=2
PIPER_ENABLED=true
```

If you set `TRAFFIC_ATC_AUDIO=true`, the backend will again speak controller responses to AI traffic. Leave it false for one-world SkyEcho ATC authority.
