const path = require('path');
const express = require('express');
const cors = require('cors');
const http = require('http');
const WebSocket = require('ws');
const config = require('./config');
const { loadCsv } = require('./csv/csvLoader');
const { buildAirportDb } = require('./csv/airportParser');
const { buildAirlineRegistry } = require('./csv/airlineParser');
const { RunwaySequencer } = require('./separation/RunwaySequencer');
const { ArrivalSequencer } = require('./separation/ArrivalSequencer');
const { GroundSequencer } = require('./separation/GroundSequencer');
const { TrafficOrchestrator } = require('./traffic/TrafficOrchestrator');
const { AtcEngine } = require('./atc/AtcEngine');
const { spokenCallsign } = require('./atc/CallsignFormatter');

const dataDir = path.join(__dirname, '..', 'data');
const airportRows = loadCsv(path.join(dataDir, 'airport_data.csv'));
const airlineRows = loadCsv(path.join(dataDir, 'airline_registry.csv'));
const routes = loadCsv(path.join(dataDir, 'routes.csv'));
const schedules = loadCsv(path.join(dataDir, 'schedules.csv'));
const airports = buildAirportDb(airportRows);
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
wss.on('connection', (ws, req) => { clients.add(ws); ws.send(JSON.stringify({ type:'hello', service:'skyecho-backend-v1', traffic: traffic.snapshot() })); ws.on('close', () => clients.delete(ws)); });

const runwaySequencer = new RunwaySequencer();
const arrivalSequencer = new ArrivalSequencer();
const groundSequencer = new GroundSequencer();
const traffic = new TrafficOrchestrator({ schedules, routes, airlineRegistry, runwaySequencer, arrivalSequencer, groundSequencer });
const atc = new AtcEngine({ runwaySequencer, airlineRegistry });
traffic.on('log', entry => broadcast({ type:'log', entry }));
traffic.on('radio', ev => broadcast({ type:'radio', event: ev }));
traffic.on('adsb', packet => broadcast(packet));

app.get('/', (req,res)=>res.json({ ok:true, service:'SkyEcho Backend v1 AI Traffic Orchestrator', ws:'/ws', health:'/health' }));
app.get('/health', (req,res)=>res.json({ ok:true, version:'1.0.0', airports:airports.size, airlines:airlineRegistry.size, running:traffic.running, clients:clients.size }));
app.get('/traffic/state', (req,res)=>res.json({ ok:true, ...traffic.snapshot() }));
app.get('/traffic/logs', (req,res)=>res.json({ ok:true, logs:traffic.logs }));
app.get('/traffic/adsb', (req,res)=>res.json({ ok:true, ...traffic.adsb() }));
app.get('/traffic/airports', (req,res)=>res.json({ ok:true, airports:Array.from(airports.values()) }));
app.post('/traffic/start', requireSecret, (req,res)=>{ const out = traffic.start({ airport:req.body.airport || config.defaultAirport, density:req.body.density || config.defaultDensity, tickMs:config.tickMs }); broadcast({ type:'traffic_started', state:out }); res.json({ ok:true, state:out }); });
app.post('/traffic/stop', requireSecret, (req,res)=>{ traffic.stop(); broadcast({ type:'traffic_stopped' }); res.json({ ok:true }); });
app.post('/traffic/pilot-event', requireSecret, (req,res)=>{ const body = req.body || {}; const userAircraft = { id:'user', callsign:body.callsign || 'BWA268', spokenCallsign: body.spokenCallsign || spokenCallsign(body.callsign || 'BWA268', airlineRegistry), dest:body.dest || 'TKPK' }; const result = atc.handlePilotEvent({ aircraft:userAircraft, text:body.text || '', airport:body.airport || body.origin || 'TKPK', runway:body.runway || '07' }); const ev = { type:'user_atc_response', input:body.text, result, t:Date.now() }; broadcast(ev); res.json({ ok:true, ...ev }); });
app.post('/bridge/event', requireSecret, (req,res)=>{ const event = { ...req.body, t:Date.now() }; traffic.log('BRIDGE', event.text || event.type || 'bridge event', event); broadcast({ type:'bridge_event', event }); res.json({ ok:true }); });

server.listen(config.port, () => console.log(`SkyEcho Backend v1 listening on ${config.port}`));
