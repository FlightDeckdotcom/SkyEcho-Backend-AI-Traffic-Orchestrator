# SkyEcho Backend v1.8 Frequency-Scoped AI Traffic

This patch prevents AI traffic from playing airborne/enroute transmissions while the user is in clearance/preflight/ground phases.

Rules:
- User preflight/clearance => AI only performs clearance readbacks.
- User ground/taxi => AI only performs push/taxi/hold-short style transmissions.
- User tower/departure => AI only performs hold-short/takeoff/departure transmissions.
- User approach/final/landing => AI only performs arrival/final/landing transmissions.
- Backend ATC remains silent/internal; only AI pilot/readback audio is audible.

Frontend v6.8 sends phase/controller/frequency context to `/traffic/start` and `/traffic/user-priority`.
