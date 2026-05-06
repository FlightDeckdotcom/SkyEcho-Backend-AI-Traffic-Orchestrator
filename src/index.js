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
const { VoiceRouter } = require('./voice/VoiceRouter');

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
  app.use('/audio', express.static(path.join(__dirname, '..', 'tmp', 'audio'), { maxAge:'10m' }));
  const server = http.createServer(app);
  const wss = new WebSocket.Server({ server, path: '/ws' });
  const clients = new Set();
  function broadcast(obj) { const msg = JSON.stringify(obj); for (const ws of clients) if (ws.readyState === WebSocket.OPEN) ws.send(msg); }
  function requireSecret(req, res, next) { const secret = req.headers['x-bridge-secret'] || req.query.secret || req.body?.secret; if (config.bridgeSecret && config.bridgeSecret !== 'change-me' && secret !== config.bridgeSecret) return res.status(401).json({ ok:false, error:'invalid bridge secret' }); next(); }

  const runwaySequencer = new RunwaySequencer();
  const arrivalSequencer = new ArrivalSequencer();
  let groundSequencer = new GroundSequencer({ airports });
  const voiceRouter = new VoiceRouter({ config, broadcast, log: (msg) => console.log(msg) });
  const trafficConfig = { ...config, getClientCount: () => clients.size };
  const traffic = new TrafficOrchestrator({ schedules, routes, airlineRegistry, runwaySequencer, arrivalSequencer, groundSequencer, config: trafficConfig, voiceRouter });
  const atc = new AtcEngine({ runwaySequencer, airlineRegistry });

  wss.on('connection', (ws) => { clients.add(ws); ws.send(JSON.stringify({ type:'hello', service:'skyecho-backend-v1.9.1-ai-audio-release', traffic: traffic.snapshot(), data: { source: navData.source, counts: navData.counts, errors: navData.errors.slice(0,8) } })); ws.on('close', () => clients.delete(ws)); });
  traffic.on('log', entry => broadcast({ type:'log', entry }));
  traffic.on('radio', ev => broadcast({ type:'radio', event: ev }));
  traffic.on('adsb', packet => broadcast(packet));

  app.get('/', (req,res)=>res.json({ ok:true, service:'SkyEcho Backend v1.9.1 AI ATC Bridge Audio Release Hotfix', ws:'/ws', health:'/health', dataStatus:'/data/status', sync:'/data/sync' }));
  app.get('/health', (req,res)=>res.json({ ok:true, version:'1.9.1', airports:airports.size, airlines:airlineRegistry.size, navSource:navData.source, navFilesLoaded:Object.values(navData.counts).filter(n=>n>0).length, running:traffic.running, clients:clients.size, oneWorldMode:traffic.oneWorldMode, userCallsigns:traffic.snapshot().userCallsigns, userPriorityActive:traffic.snapshot().userPriorityActive }));
  app.get('/data/status', (req,res)=>res.json({ ok:true, version:'1.9.1', source:navData.source, baseUrl:config.navDataBaseUrl, counts:navData.counts, loadedFiles:navData.loadedFiles, errors:navData.errors, normalizedAirportRows:airportRows.length, airportDbSize:airports.size, availableFiles:FILES }));
  app.post('/data/sync', requireSecret, async (req,res)=>{
    const mode = req.body?.mode || 'boot';
    const files = Array.isArray(req.body?.files) && req.body.files.length ? req.body.files : (mode === 'full' ? FILES : BOOT_FILES);
    try {
      const next = await loadNavData({ dataDir, baseUrl: config.navDataBaseUrl || DEFAULT_NAVDATA_BASE_URL, preferRemote:true, files, timeoutMs: Number(req.body?.timeoutMs || 12000), maxBytes: Number(req.body?.maxBytes || 6000000) });
      let nextAirportRows = normalizeAirportRows(next);
      const scopeList = Array.isArray(req.body?.airports) ? req.body.airports.map(x=>String(x).toUpperCase()) : [];
      if (scopeList.length) {
        const scopeSet = new Set(scopeList);
        nextAirportRows = nextAirportRows.filter(r => scopeSet.has(String(r.airport_icao || '').toUpperCase()));
      }
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
  app.post('/traffic/user-state', requireSecret, (req,res)=>{ const body=req.body||{}; const user=traffic.setUserAircraft(body); if (body.pttActive || body.transmitting) traffic.setUserPtt(true, body.holdMs || config.userPttHoldMs); if (body.priorityHold) traffic.setUserPriority(body.holdMs || config.userPriorityHoldMs, body.reason || 'user state'); const out={ ok:true, userAircraft:user, snapshot:traffic.snapshot() }; broadcast({ type:'user_state', ...out }); res.json(out); });
  app.post('/traffic/user-priority', requireSecret, (req,res)=>{ const body=req.body||{}; if (body.callsign || body.userCallsign) traffic.setUserAircraft({ callsign:body.callsign || body.userCallsign, spokenCallsign:body.spokenCallsign, origin:body.origin || body.airport, dest:body.dest, runway:body.runway }); traffic.setUserPriority(body.holdMs || config.userPriorityHoldMs, body.reason || 'frontend user priority'); if (body.pttActive || body.transmitting) traffic.setUserPtt(true, body.holdMs || config.userPttHoldMs); const out={ ok:true, snapshot:traffic.snapshot() }; broadcast({ type:'user_priority', ...out }); res.json(out); });
  app.get('/traffic/logs', (req,res)=>res.json({ ok:true, logs:traffic.logs }));
  app.get('/traffic/adsb', (req,res)=>res.json({ ok:true, ...traffic.adsb() }));
  app.get('/voice/status', (req,res)=>res.json({ ok:true, piperEnabled:config.piperEnabled, radioMinGapMs:config.radioMinGapMs, aiPhaseScale:config.aiPhaseScale, maxTrafficDensity:config.maxTrafficDensity, atcVoice:config.atcPiperVoice, trafficVoicePool:config.trafficPiperVoicePool, cabinVoice:config.cabinPiperVoice, discordBridgeUrl: config.discordBridgeUrl ? 'configured' : 'not configured', trafficAtcAudio: config.trafficAtcAudio, aiPilotAudio: config.aiPilotAudio }));
  app.post('/voice/test', requireSecret, async (req,res)=>{ const body=req.body||{}; const role=body.role||'traffic'; const ac={ callsign:body.callsign||'BWA268', spokenCallsign:body.spokenCallsign||spokenCallsign(body.callsign||'BWA268', airlineRegistry) }; const ev={ type:'radio', role: role==='atc'?'atc':'pilot', callsign:ac.callsign, spokenCallsign:ac.spokenCallsign, text: body.text || `${ac.spokenCallsign}, radio check.`, meta:{ test:true }, t:Date.now() }; const out = await voiceRouter.routeRadio(ev); res.json({ ok:true, voice:out }); });
  app.get('/traffic/airports', (req,res)=>res.json({ ok:true, airports:Array.from(airports.values()).slice(0,500) }));
  app.post('/traffic/start', requireSecret, (req,res)=>{ const out = traffic.start({ airport:req.body.airport || config.defaultAirport, density:req.body.density || config.defaultDensity, userCallsign:req.body.userCallsign || req.body.callsign, origin:req.body.origin, dest:req.body.dest, runway:req.body.runway, route:req.body.route, phase:req.body.phase || req.body.userPhase, frequency:req.body.frequency || req.body.userFrequency, controllerRole:req.body.controllerRole || req.body.userControllerRole, tickMs:config.tickMs }); broadcast({ type:'traffic_started', state:out }); res.json({ ok:true, state:out }); });
  app.post('/traffic/stop', requireSecret, (req,res)=>{ traffic.stop(); broadcast({ type:'traffic_stopped' }); res.json({ ok:true }); });
  app.post('/traffic/ai-atc-instruction', requireSecret, async (req,res)=>{
    try {
      const out = await traffic.handleAiAtcInstruction(req.body || {});
      broadcast({ type:'ai_atc_instruction_accepted', ...out });
      res.json({ ok:true, ...out });
    } catch (e) {
      res.status(400).json({ ok:false, error:e.message });
    }
  });
  app.post('/traffic/pilot-event', requireSecret, (req,res)=>{ const body = req.body || {}; const userAircraft = { id:'user', callsign:body.callsign || 'BWA268', spokenCallsign: body.spokenCallsign || spokenCallsign(body.callsign || 'BWA268', airlineRegistry), dest:body.dest || 'TKPK' }; traffic.setUserAircraft({ callsign:userAircraft.callsign, spokenCallsign:userAircraft.spokenCallsign, origin:body.origin || body.airport || 'TKPK', dest:body.dest, runway:body.runway || '07' });
    traffic.setUserPriority(config.userPriorityHoldMs, 'user pilot event');
    const result = atc.handlePilotEvent({ aircraft:userAircraft, text:body.text || '', airport:body.airport || body.origin || 'TKPK', runway:body.runway || '07' }); const ev = { type:'user_atc_response', input:body.text, result, t:Date.now() }; broadcast(ev); res.json({ ok:true, ...ev }); });
  app.post('/bridge/event', requireSecret, (req,res)=>{ const event = { ...req.body, t:Date.now() };
    if (event.callsign || event.userCallsign) traffic.setUserAircraft({ callsign:event.callsign || event.userCallsign, spokenCallsign:event.spokenCallsign, origin:event.origin || event.airport, dest:event.dest, runway:event.runway });
    if (/ptt|transmit|user_speaking|pilot_tx/i.test(String(event.type || '')) || event.pttActive || event.transmitting) {
      const active = event.active !== false && event.pttActive !== false && event.transmitting !== false;
      traffic.setUserPtt(active, event.holdMs || event.durationMs || config.userPttHoldMs);
    }
    traffic.log('BRIDGE', event.text || event.type || 'bridge event', event); broadcast({ type:'bridge_event', event }); res.json({ ok:true, snapshot:traffic.snapshot() }); });

  server.listen(config.port, () => console.log(`SkyEcho Backend v1.9.1 listening on ${config.port}; AI-BRIDGE-AUDIO-RELEASE; SAFE BOOT; local nav files=${Object.values(navData.counts).filter(n=>n>0).length}; airports=${airports.size}`));
}
main().catch(err => { console.error('SkyEcho Backend fatal startup error:', err); process.exit(1); });
