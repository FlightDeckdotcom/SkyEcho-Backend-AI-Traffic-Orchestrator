const path = require('path');
const express = require('express');
const cors = require('cors');
const http = require('http');
const WebSocket = require('ws');
const config = require('./config');
const { loadCsv } = require('./csv/csvLoader');
const { loadNavData, normalizeAirportRows, DEFAULT_NAVDATA_BASE_URL, FILES, BOOT_FILES } = require('./csv/githubNavData');
const { buildAirportDb } = require('./csv/airportParser');
const { buildAirlineRegistry } = require('./csv/airlineParser');
const { RunwaySequencer } = require('./separation/RunwaySequencer');
const { ArrivalSequencer } = require('./separation/ArrivalSequencer');
const { GroundSequencer } = require('./separation/GroundSequencer');
const { TrafficOrchestrator } = require('./traffic/TrafficOrchestrator');
const { AtcEngine } = require('./atc/AtcEngine');
const { spokenCallsign } = require('./atc/CallsignFormatter');

async function main() {
  const dataDir = path.join(__dirname, '..', 'data');

  // v1.2: boot safely from local starter data first. Remote GitHub navdata is lazy-loaded after the server is alive.
  let navData = await loadNavData({ dataDir, baseUrl: config.navDataBaseUrl || DEFAULT_NAVDATA_BASE_URL, preferRemote:false, files:BOOT_FILES });
  let airportRows = normalizeAirportRows(navData);
  if (!airportRows.length) airportRows = loadCsv(path.join(dataDir, 'airport_data.csv'));
  const airlineRows = loadCsv(path.join(dataDir, 'airline_registry.csv'));
  const routes = loadCsv(path.join(dataDir, 'routes.csv'));
  const schedules = loadCsv(path.join(dataDir, 'schedules.csv'));
  let airports = buildAirportDb(airportRows);
  const airlineRegistry = buildAirlineRegistry(airlineRows);

  const app = express();
  app.use(cors({ origin: true, credentials: false, allowedHeaders: ['Content-Type','x-bridge-secret','Authorization'] }));
  app.options('*', cors());
  app.use(express.json({ limit:'2mb' }));
  const server = http.createServer(app);
  const wss = new WebSocket.Server({ server, path: '/ws' });
  const clients = new Set();
  function broadcast(obj) { const msg = JSON.stringify(obj); for (const ws of clients) if (ws.readyState === WebSocket.OPEN) ws.send(msg); }
  function requireSecret(req, res, next) { const secret = req.headers['x-bridge-secret'] || req.query.secret || req.body?.secret; if (config.bridgeSecret && config.bridgeSecret !== 'change-me' && secret !== config.bridgeSecret) return res.status(401).json({ ok:false, error:'invalid bridge secret' }); next(); }

  const runwaySequencer = new RunwaySequencer();
  const arrivalSequencer = new ArrivalSequencer();
  let groundSequencer = new GroundSequencer({ airports });
  const traffic = new TrafficOrchestrator({ schedules, routes, airlineRegistry, runwaySequencer, arrivalSequencer, groundSequencer });
  const atc = new AtcEngine({ runwaySequencer, airlineRegistry });

  wss.on('connection', (ws) => { clients.add(ws); ws.send(JSON.stringify({ type:'hello', service:'skyecho-backend-v1.2', traffic: traffic.snapshot(), data: { source: navData.source, counts: navData.counts, errors: navData.errors.slice(0,8) } })); ws.on('close', () => clients.delete(ws)); });
  traffic.on('log', entry => broadcast({ type:'log', entry }));
  traffic.on('radio', ev => broadcast({ type:'radio', event: ev }));
  traffic.on('adsb', packet => broadcast(packet));

  app.get('/', (req,res)=>res.json({ ok:true, service:'SkyEcho Backend v1.2 AI Traffic Orchestrator', ws:'/ws', health:'/health', dataStatus:'/data/status', sync:'/data/sync' }));
  app.get('/health', (req,res)=>res.json({ ok:true, version:'1.2.0', airports:airports.size, airlines:airlineRegistry.size, navSource:navData.source, navFilesLoaded:Object.values(navData.counts).filter(n=>n>0).length, running:traffic.running, clients:clients.size }));
  app.get('/data/status', (req,res)=>res.json({ ok:true, version:'1.2.0', source:navData.source, baseUrl:config.navDataBaseUrl, counts:navData.counts, loadedFiles:navData.loadedFiles, errors:navData.errors, normalizedAirportRows:airportRows.length, airportDbSize:airports.size, availableFiles:FILES }));
  app.post('/data/sync', requireSecret, async (req,res)=>{
    const mode = req.body?.mode || 'boot';
    const files = Array.isArray(req.body?.files) && req.body.files.length ? req.body.files : (mode === 'full' ? FILES : BOOT_FILES);
    try {
      const next = await loadNavData({ dataDir, baseUrl: config.navDataBaseUrl || DEFAULT_NAVDATA_BASE_URL, preferRemote:true, files, timeoutMs: Number(req.body?.timeoutMs || 12000), maxBytes: Number(req.body?.maxBytes || 6000000) });
      const nextAirportRows = normalizeAirportRows(next);
      if (nextAirportRows.length) {
        navData = next;
        airportRows = nextAirportRows;
        airports = buildAirportDb(airportRows);
        groundSequencer = new GroundSequencer({ airports });
        traffic.groundSequencer = groundSequencer;
      } else {
        navData = next;
      }
      const payload = { ok:true, source:navData.source, counts:navData.counts, loadedFiles:navData.loadedFiles, errors:navData.errors, normalizedAirportRows:airportRows.length, airportDbSize:airports.size };
      broadcast({ type:'data_synced', data:payload });
      res.json(payload);
    } catch (e) {
      res.status(500).json({ ok:false, error:e.message });
    }
  });
  app.get('/traffic/state', (req,res)=>res.json({ ok:true, ...traffic.snapshot() }));
  app.get('/traffic/logs', (req,res)=>res.json({ ok:true, logs:traffic.logs }));
  app.get('/traffic/adsb', (req,res)=>res.json({ ok:true, ...traffic.adsb() }));
  app.get('/traffic/airports', (req,res)=>res.json({ ok:true, airports:Array.from(airports.values()).slice(0,500) }));
  app.post('/traffic/start', requireSecret, (req,res)=>{ const out = traffic.start({ airport:req.body.airport || config.defaultAirport, density:req.body.density || config.defaultDensity, tickMs:config.tickMs }); broadcast({ type:'traffic_started', state:out }); res.json({ ok:true, state:out }); });
  app.post('/traffic/stop', requireSecret, (req,res)=>{ traffic.stop(); broadcast({ type:'traffic_stopped' }); res.json({ ok:true }); });
  app.post('/traffic/pilot-event', requireSecret, (req,res)=>{ const body = req.body || {}; const userAircraft = { id:'user', callsign:body.callsign || 'BWA268', spokenCallsign: body.spokenCallsign || spokenCallsign(body.callsign || 'BWA268', airlineRegistry), dest:body.dest || 'TKPK' }; const result = atc.handlePilotEvent({ aircraft:userAircraft, text:body.text || '', airport:body.airport || body.origin || 'TKPK', runway:body.runway || '07' }); const ev = { type:'user_atc_response', input:body.text, result, t:Date.now() }; broadcast(ev); res.json({ ok:true, ...ev }); });
  app.post('/bridge/event', requireSecret, (req,res)=>{ const event = { ...req.body, t:Date.now() }; traffic.log('BRIDGE', event.text || event.type || 'bridge event', event); broadcast({ type:'bridge_event', event }); res.json({ ok:true }); });

  server.listen(config.port, () => console.log(`SkyEcho Backend v1.2 listening on ${config.port}; SAFE BOOT; local nav files=${Object.values(navData.counts).filter(n=>n>0).length}; airports=${airports.size}`));
}
main().catch(err => { console.error('SkyEcho Backend fatal startup error:', err); process.exit(1); });
