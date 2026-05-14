'use strict';

const { TrafficWorld } = require('./TrafficWorld');
const { installOpenSkyIntoTrafficWorld } = require('./OpenSkyTrafficV2Integration');
const { registerOpenSkyTrafficV2Routes } = require('./registerOpenSkyTrafficV2Routes');

function registerTrafficV2Routes({
  app,
  wss,
  broadcast,
  requireSecret,
  config,
  airports,
  routes,
  schedules,
  log
}) {
  const trafficV2 = new TrafficWorld({
    airports,
    routes,
    schedules,
    config,
    log
  });

  // OpenSky live aircraft seeding + regional governance integration.
  // This keeps OpenSky as a live ADS-B seed source only.
  // SkyEcho Traffic v2 still controls phase logic, frequency filtering,
  // radio queueing, squawk fallback, and Piper TTS behavior.
  installOpenSkyIntoTrafficWorld(trafficV2);
  registerOpenSkyTrafficV2Routes({ app, requireSecret, trafficV2 });

  trafficV2.on('state', (state) => {
    if (broadcast) {
      broadcast({
        type: 'traffic_v2_state',
        state
      });
    }
  });

  trafficV2.on('adsb', (packet) => {
    if (broadcast) {
      broadcast(packet);
    }
  });

  trafficV2.on('queue', (queue) => {
    if (broadcast) {
      broadcast({
        type: 'traffic_v2_queue',
        queue
      });
    }
  });

  trafficV2.on('radio', (event) => {
    if (broadcast) {
      broadcast({
        type: 'traffic_v2_radio',
        event
      });
    }
  });

  app.get('/traffic-v2/health', (req, res) => {
    res.json({
      ok: true,
      service: 'SkyEcho Traffic Engine v2',
      state: trafficV2.snapshot().radio,
      opensky: trafficV2.opensky ? trafficV2.opensky.snapshot() : null
    });
  });

  app.post('/traffic-v2/start', requireSecret, (req, res) => {
    const state = trafficV2.start(req.body || {});

    res.json({
      ok: true,
      state
    });
  });

  app.post('/traffic-v2/stop', requireSecret, (req, res) => {
    trafficV2.stop();

    res.json({
      ok: true
    });
  });

  app.get('/traffic-v2/state', (req, res) => {
    res.json(trafficV2.snapshot());
  });

  app.get('/traffic-v2/adsb', (req, res) => {
    res.json({
      ok: true,
      ...trafficV2.adsbPacket()
    });
  });

  app.get('/traffic-v2/radio-queue', (req, res) => {
    res.json({
      ok: true,
      queue: trafficV2.radio.snapshot()
    });
  });

  app.post('/traffic-v2/user-frequency', requireSecret, (req, res) => {
    trafficV2.setUserFrequency(
      req.body?.frequency || req.body?.userFrequency
    );

    res.json({
      ok: true,
      radio: trafficV2.radio.snapshot()
    });
  });

  app.post('/traffic-v2/audio-lock', requireSecret, (req, res) => {
    trafficV2.setAudioLock({
      source: req.body?.source,
      busy: req.body?.busy
    });

    res.json({
      ok: true,
      radio: trafficV2.radio.snapshot()
    });
  });

  app.post('/traffic-v2/audio-finished', requireSecret, (req, res) => {
    trafficV2.notifyAudioFinished();

    res.json({
      ok: true,
      radio: trafficV2.radio.snapshot()
    });
  });

  app.post('/traffic-v2/ai-atc-instruction', requireSecret, (req, res) => {
    res.json(
      trafficV2.handleAiAtcInstruction(req.body || {})
    );
  });

  return trafficV2;
}

module.exports = {
  registerTrafficV2Routes
};
