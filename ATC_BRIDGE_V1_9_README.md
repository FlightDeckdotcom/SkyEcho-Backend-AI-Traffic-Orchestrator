# SkyEcho Backend v1.9 – AI ATC Bridge

AI traffic no longer invents readbacks on its own. The backend emits `ai_pilot_request` events to the frontend. The frontend/SkyEchoCabin side issues an ATC instruction and posts it back to `/traffic/ai-atc-instruction`. Only then does the backend generate AI pilot readback audio.

Important env vars:
- AI_ATC_BRIDGE_REQUIRED=true
- TRAFFIC_ATC_AUDIO=false
- AI_PILOT_AUDIO=true
- AI_PILOT_READBACK_ONLY=false
- ALLOW_AI_PILOT_REQUESTS=true
- ONE_WORLD_MODE=true
