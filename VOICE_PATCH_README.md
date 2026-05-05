# SkyEcho Backend v1.3 Voice + Pacing Patch

This patch adds role-based voice routing and slows AI traffic radio pacing.

## What changed

- ATC radio events route to Piper high voice.
- AI traffic/pilot radio events route to Piper medium voice pool.
- Cabin can use Piper medium voice.
- Radio queue is throttled with `RADIO_MIN_GAP_MS`.
- AI state-machine timings are slowed with `AI_PHASE_SCALE`.
- Traffic density is capped with `MAX_TRAFFIC_DENSITY`.
- Backend exposes `/voice/status` and `/voice/test`.
- Optional `/audio/*.wav` static output if `PIPER_ENABLED=true`.

## Render environment variables

```txt
PIPER_ENABLED=false
ATC_TTS_MODE=piper
TRAFFIC_TTS_MODE=piper
CABIN_TTS_MODE=piper
ATC_PIPER_VOICE=models/piper/atc/high/en_US-ryan-high.onnx
TRAFFIC_PIPER_VOICE_POOL=models/piper/traffic/medium/en_US-lessac-medium.onnx
CABIN_PIPER_VOICE=models/piper/cabin/medium/en_US-lessac-medium.onnx
RADIO_MIN_GAP_MS=11000
AI_PHASE_SCALE=2.5
MAX_TRAFFIC_DENSITY=2
DISCORD_BRIDGE_URL=https://sky-echo-cabin-xbox-and-ps5.onrender.com
DISCORD_BRIDGE_SECRET=same_secret_as_bridge
```

Start with `PIPER_ENABLED=false` first. That confirms voice events and pacing without making Render spend CPU generating WAVs. Once voice events forward to the Discord bridge, then enable Piper generation if needed.

## Render build command

Render does not have git-lfs by default. Use direct voice downloads if you want the models available at runtime:

```bash
mkdir -p models/piper/atc/high models/piper/traffic/medium models/piper/cabin/medium && curl -L -o models/piper/atc/high/en_US-ryan-high.onnx "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/ryan/high/en_US-ryan-high.onnx?download=true" && curl -L -o models/piper/atc/high/en_US-ryan-high.onnx.json "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/ryan/high/en_US-ryan-high.onnx.json?download=true" && curl -L -o models/piper/traffic/medium/en_US-lessac-medium.onnx "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx?download=true" && curl -L -o models/piper/traffic/medium/en_US-lessac-medium.onnx.json "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx.json?download=true" && cp models/piper/traffic/medium/en_US-lessac-medium.onnx models/piper/cabin/medium/en_US-lessac-medium.onnx && cp models/piper/traffic/medium/en_US-lessac-medium.onnx.json models/piper/cabin/medium/en_US-lessac-medium.onnx.json && corepack enable && yarn install
```

## Test after deploy

Open:

```txt
https://skyecho-backend-ai-traffic-orchestrator.onrender.com/voice/status
```

Then test a traffic voice event with a POST to `/voice/test` using your bridge secret.
