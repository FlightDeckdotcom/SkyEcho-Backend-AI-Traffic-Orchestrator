# SkyEcho Backend v1.7 – ATC Session Sync / Readback-Only AI Traffic

This patch keeps the SkyEchoCabin main ATC engine as the only audible controller.
AI traffic no longer makes open requests that need a separate backend ATC answer.
Instead the backend uses internal/silent controller decisions, then plays only AI pilot readbacks/reports.

Key behavior:
- No repeated audible backend controller voice.
- No unanswered AI traffic requests.
- AI traffic radio is readback/report only.
- User priority endpoint added: POST /traffic/user-priority.
- Radio queue drops/holds traffic while the user PTT/transmit is active.

Recommended env:
ONE_WORLD_MODE=true
TRAFFIC_ATC_AUDIO=false
AI_PILOT_AUDIO=true
AI_PILOT_READBACK_ONLY=true
ALLOW_AI_PILOT_REQUESTS=false
DROP_TRAFFIC_AUDIO_DURING_USER_PRIORITY=true
USER_PRIORITY_HOLD_MS=18000
USER_PTT_HOLD_MS=10000
RADIO_EVENT_MIN_MS=25000
RADIO_EVENT_MAX_MS=55000
MAX_RADIO_QUEUE=4
