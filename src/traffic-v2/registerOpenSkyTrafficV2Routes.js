'use strict';

function registerOpenSkyTrafficV2Routes({ app, requireSecret, trafficV2 }) {
  app.get('/traffic-v2/opensky/status', (req, res) => {
    res.json({ ok: true, opensky: trafficV2.opensky ? trafficV2.opensky.snapshot() : null, userAircraftState: trafficV2.userAircraftState || null });
  });

  app.post('/traffic-v2/user-aircraft-state', requireSecret, (req, res) => {
    const state = trafficV2.updateUserAircraftState(req.body || {});
    res.json({ ok: true, userAircraftState: state, radio: trafficV2.radio.snapshot() });
  });

  app.post('/traffic-v2/opensky/sync', requireSecret, async (req, res) => {
    try {
      const out = await trafficV2.syncOpenSkyNearby(req.body || {});
      res.json(out);
    } catch (err) {
      res.status(502).json({ ok: false, error: String(err && err.message ? err.message : err), opensky: trafficV2.opensky ? trafficV2.opensky.snapshot() : null });
    }
  });
}

module.exports = { registerOpenSkyTrafficV2Routes };
