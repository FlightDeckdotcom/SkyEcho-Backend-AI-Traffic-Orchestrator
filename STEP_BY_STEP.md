# Step-by-step integration

## Step 1 — Create a new GitHub repository

Name it:

```text
SkyEcho-Backend-AI-Traffic-Orchestrator
```

Upload all files from this package root so GitHub root contains:

```text
package.json
src/
data/
frontend/
README.md
```

## Step 2 — Deploy to Render

Render → New + → Web Service

Settings:

```text
Runtime: Node
Build Command: npm install
Start Command: npm start
```

Environment variables:

```text
NODE_VERSION=20.18.1
PORT=10000
BRIDGE_SECRET=choose_a_private_secret
DEFAULT_AIRPORT=TKPK
DEFAULT_DENSITY=3
TRAFFIC_TICK_MS=1000
ADS_BROADCAST_MS=1000
```

Deploy.

## Step 3 — Test the backend

Open:

```text
https://YOUR-BACKEND.onrender.com/health
```

Expected:

```json
{ "ok": true, "version": "1.0.0" }
```

## Step 4 — Start backend traffic

Use the floating frontend panel or run:

```bash
curl -X POST https://YOUR-BACKEND.onrender.com/traffic/start \
  -H "Content-Type: application/json" \
  -H "x-bridge-secret: YOUR_SECRET" \
  -d '{"airport":"TKPK","density":3}'
```

## Step 5 — Connect SkyEchoCabin frontend

Do not replace your whole app blindly.

Open your working `index.html`, then paste:

```text
frontend/skyecho_backend_v1_frontend_patch.js
```

right before the final:

```html
</body>
```

This adds a floating backend panel without touching the core bundled React app.

## Step 6 — Disable old frontend traffic

In SkyEchoCabin, turn off any old frontend traffic injection buttons if they are still visible.

Use the new panel:

```text
Start Backend Traffic
Stop Traffic
```

## Step 7 — What to verify

Test these:

```text
BWA268 → Caribbean Airlines two six eight
established on G633 → established_on_route
established localizer runway 07 → established_final_or_ils
clear of runway 07 request taxi to FBO → taxi-in to FBO
```

Watch backend logs and frontend WebSocket logs.

## Step 8 — Discord bridge

Keep your Discord bridge separate for now.

Final architecture:

```text
SkyEchoCabin Web App → SkyEcho Backend AI Traffic Orchestrator → Discord Bridge audio playback
```

The backend produces official traffic/ATC events. The Discord bridge only plays audio into Xbox/PS5 Discord.
