const EventEmitter = require('events');
const { spawnFromSchedules, normalizeCallsign } = require('./SpawnManager');
const { updateKinematics } = require('./AircraftStateMachine');
const Phrase = require('../atc/Phraseology');
const { adsbPacket } = require('./TelemetryBroadcaster');

function scaled(ms, scale=1) { return Math.max(8000, Math.round(ms * scale)); }

class TrafficOrchestrator extends EventEmitter {
  constructor({ schedules, routes, airlineRegistry, runwaySequencer, arrivalSequencer, groundSequencer, config = {}, voiceRouter = null }) {
    super();
    this.schedules = schedules; this.routes = routes; this.airlineRegistry = airlineRegistry;
    this.runwaySequencer = runwaySequencer; this.arrivalSequencer = arrivalSequencer; this.groundSequencer = groundSequencer;
    this.config = config;
    this.voiceRouter = voiceRouter;
    this.aircraft = []; this.running = false; this.timer = null; this.airport = 'TKPK';
    this.density = Number(config.defaultDensity || 1); this.logs = [];
    this.radioQueue = [];
    this.lastRadioAt = 0;
    this.radioMinGapMs = Number(config.radioMinGapMs || 11000);
    this.phaseScale = Number(config.aiPhaseScale || 2.5);
    this.radioEventMinMs = Number(config.radioEventMinMs || 20000);
    this.radioEventMaxMs = Math.max(this.radioEventMinMs, Number(config.radioEventMaxMs || 45000));
    this.maxRadioQueue = Number(config.maxRadioQueue || 8);
    this.minSessionAircraft = Number(config.aiSessionAircraftMin || 3);
    this.maxSessionAircraft = Number(config.aiSessionAircraftMax || 7);
    this.nextGlobalActionAt = 0;
    this.scopeAirports = new Set();
    this.getClientCount = typeof config.getClientCount === 'function' ? config.getClientCount : (() => 1);
    this.pausedForNoClients = false;
    this.oneWorldMode = config.oneWorldMode !== false;
    this.userCallsigns = new Set(String(config.userCallsigns || '').split(',').map(normalizeCallsign).filter(Boolean));
    this.userAircraft = null;
    this.userPriorityUntil = 0;
    this.userPttActive = false;
  }

  setUserAircraft(data = {}) {
    const callsign = data.callsign || data.userCallsign || data.flightCallsign;
    const norm = normalizeCallsign(callsign);
    if (!norm) return this.userAircraft;
    this.userCallsigns.add(norm);
    this.userAircraft = {
      id: 'user',
      callsign: norm,
      spokenCallsign: data.spokenCallsign || data.spoken || norm,
      origin: data.origin || data.airport || this.airport,
      dest: data.dest || data.destination || data.to || undefined,
      runway: data.runway || '07',
      updatedAt: Date.now()
    };
    this.removeUserAircraftFromTraffic();
    return this.userAircraft;
  }

  isUserCallsign(callsign) {
    return this.userCallsigns.has(normalizeCallsign(callsign));
  }

  removeUserAircraftFromTraffic() {
    const before = this.aircraft.length;
    this.aircraft = this.aircraft.filter(ac => !this.isUserCallsign(ac.callsign));
    const removed = before - this.aircraft.length;
    if (removed > 0) this.log('WORLD', `Removed ${removed} AI aircraft using the user's callsign.`, { userCallsigns:[...this.userCallsigns] });
  }

  setUserPriority(ms, reason='user transmission') {
    const hold = Math.max(1500, Number(ms || this.config.userPriorityHoldMs || 9000));
    this.userPriorityUntil = Math.max(this.userPriorityUntil || 0, Date.now() + hold);
    this.log('WORLD', `User priority hold active: ${reason}`, { until:this.userPriorityUntil, holdMs:hold });
  }

  setUserPtt(active, ms) {
    this.userPttActive = !!active;
    if (active) this.setUserPriority(ms || this.config.userPttHoldMs || 4500, 'PTT active');
  }

  log(type, text, data={}) {
    const entry = { t: new Date().toISOString(), type, text, data };
    this.logs.unshift(entry); this.logs = this.logs.slice(0, 500); this.emit('log', entry); return entry;
  }

  radio(role, aircraft, text, meta={}) {
    const nextMeta = { ...(meta || {}) };
    if (role === 'atc') {
      nextMeta.controllerScope = nextMeta.controllerScope || 'ai_traffic';
      nextMeta.silentController = this.oneWorldMode && this.config.trafficAtcAudio !== true;
    }
    // v1.6: in single-controller mode, backend ATC for AI traffic is internal only.
    // Do not queue it for audio at all. Main SkyEchoCabin ATC remains the audible controller.
    if (role === 'atc' && nextMeta.silentController) {
      const internal = { type:'controller_internal', role, callsign:aircraft.callsign, spokenCallsign:aircraft.spokenCallsign, text, meta:nextMeta, t:Date.now() };
      this.log('INTERNAL_ATC', text, internal);
      this.emit('radio', internal);
      return internal;
    }

    const ev = { type:'radio', role, callsign: aircraft.callsign, spokenCallsign: aircraft.spokenCallsign, text, meta: nextMeta, queuedAt: Date.now(), t: Date.now() };
    this.radioQueue.push(ev);
    if (this.radioQueue.length > this.maxRadioQueue) {
      const overflow = this.radioQueue.length - this.maxRadioQueue;
      this.radioQueue.splice(0, overflow);
      this.log('QUEUE', `Dropped ${overflow} stale radio items; max queue ${this.maxRadioQueue}.`, { maxRadioQueue:this.maxRadioQueue });
    }
    this.log('QUEUE', `${role.toUpperCase()} queued: ${text}`, { callsign: aircraft.callsign, role, queueDepth:this.radioQueue.length, meta });
    this.processRadioQueue();
    return ev;
  }

  processRadioQueue(force=false) {
    const now = Date.now();
    if (!force && this.oneWorldMode && (this.userPttActive || now < this.userPriorityUntil)) {
      if (this.config.dropTrafficAudioDuringUserPriority) {
        // Drop pending AI pilot/controller chatter while the real user has the frequency.
        // This prevents stale AI calls from playing over or immediately after the user.
        const before = this.radioQueue.length;
        this.radioQueue = this.radioQueue.filter(ev => ev.meta && ev.meta.mustKeep);
        const dropped = before - this.radioQueue.length;
        if (dropped > 0) this.log('WORLD', `Dropped ${dropped} queued AI radio items during user priority window.`, { userPriorityUntil:this.userPriorityUntil });
      }
      return;
    }
    if (!force && now - this.lastRadioAt < this.radioMinGapMs) return;
    const ev = this.radioQueue.shift();
    if (!ev) return;
    ev.t = now;
    this.lastRadioAt = now;
    this.log(ev.role === 'atc' ? 'ATC' : 'PILOT', ev.text, ev);
    this.emit('radio', ev);
    if (this.voiceRouter) this.voiceRouter.routeRadio(ev).catch(err => this.log('VOICE_ERROR', err.message, { event:ev }));
  }

  start(opts={}) {
    this.stop();
    this.airport = opts.airport || this.airport;
    if (opts.userCallsign || opts.callsign || opts.flightCallsign) this.setUserAircraft({ callsign: opts.userCallsign || opts.callsign || opts.flightCallsign, origin: opts.origin || this.airport, dest: opts.dest, runway: opts.runway });
    const requestedDensity = Number(opts.density || this.density || this.minSessionAircraft);
    const maxDensity = Number(this.config.maxTrafficDensity || this.maxSessionAircraft);
    this.density = Math.max(this.minSessionAircraft, Math.min(requestedDensity, maxDensity, this.maxSessionAircraft));
    this.scopeAirports = this.buildScopeAirports(opts);
    this.aircraft = spawnFromSchedules(this.schedules, this.routes, this.airlineRegistry, {
      density: this.density,
      minAircraft: this.minSessionAircraft,
      maxAircraft: this.maxSessionAircraft,
      targetCount: this.density,
      scopeAirports: [...this.scopeAirports],
      excludeCallsigns: [...this.userCallsigns]
    });
    this.removeUserAircraftFromTraffic();
    this.running = true;
    this.lastRadioAt = 0;
    this.radioQueue = [];
    this.nextGlobalActionAt = Date.now() + this.randomBetween(2500, 6500);
    this.log('SYSTEM', `Backend AI scoped traffic started for ${this.airport}. ${this.aircraft.length} aircraft spawned. scope=${[...this.scopeAirports].join('/') || 'local'} radioEvent=${this.radioEventMinMs}-${this.radioEventMaxMs}ms maxQueue=${this.maxRadioQueue}`);
    this.timer = setInterval(() => this.tick(), opts.tickMs || 1000);
    return this.snapshot();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null; this.running = false;
    if (this.aircraft.length) this.log('SYSTEM', 'Backend AI traffic stopped.');
    this.aircraft = []; this.radioQueue = [];
  }

  snapshot() { return { running:this.running, airport:this.airport, density:this.density, aircraft:this.aircraft, runwayReservations:this.runwaySequencer.snapshot(), radioQueueDepth:this.radioQueue.length, maxRadioQueue:this.maxRadioQueue, radioMinGapMs:this.radioMinGapMs, radioEventMinMs:this.radioEventMinMs, radioEventMaxMs:this.radioEventMaxMs, scopeAirports:[...this.scopeAirports], pausedForNoClients:this.pausedForNoClients, oneWorldMode:this.oneWorldMode, trafficAtcAudio:!!this.config.trafficAtcAudio, aiPilotAudio:this.config.aiPilotAudio!==false, userAircraft:this.userAircraft, userCallsigns:[...this.userCallsigns], userPriorityActive:Date.now()<this.userPriorityUntil||this.userPttActive, userPriorityUntil:this.userPriorityUntil, logs:this.logs.slice(0,50) }; }
  adsb() { return { type:'adsb_update', aircraft:this.aircraft.map(adsbPacket) }; }

  tick() {
    const now = Date.now();
    if (this.config.autoPauseNoClients && this.getClientCount() <= 0) {
      if (!this.pausedForNoClients) this.log('SYSTEM', 'AI traffic paused: no frontend clients connected.');
      this.pausedForNoClients = true;
      return;
    }
    if (this.pausedForNoClients) this.log('SYSTEM', 'AI traffic resumed: frontend client connected.');
    this.pausedForNoClients = false;

    this.processRadioQueue();
    this.removeUserAircraftFromTraffic();
    this.arrivalSequencer.update(this.aircraft);

    // Lightweight radio-event mode: no full-world sim loop. Only update light
    // kinematics and choose one scoped aircraft every 20-45 seconds.
    for (const ac of this.aircraft) updateKinematics(ac, 1);
    if (now >= this.nextGlobalActionAt && this.radioQueue.length < this.maxRadioQueue) {
      const ac = this.chooseValidAircraft(now);
      if (ac) this.stepAircraft(ac, now);
      this.nextGlobalActionAt = now + this.randomBetween(this.radioEventMinMs, this.radioEventMaxMs);
    }
    this.emit('adsb', this.adsb());
  }

  wait(ms) { return scaled(ms, this.phaseScale); }
  randomBetween(min, max) { return Math.round(Number(min) + Math.random() * Math.max(0, Number(max) - Number(min))); }

  buildScopeAirports(opts={}) {
    const set = new Set();
    const add = v => { String(v || '').split(/[\s,;>]+/).map(x=>x.trim().toUpperCase()).filter(Boolean).forEach(x => { if (/^[A-Z0-9]{3,4}$/.test(x)) set.add(x); }); };
    add(opts.airport || this.airport);
    add(opts.origin);
    add(opts.dest || opts.destination);
    add(opts.route);
    add(opts.flightPlanAirports);
    if (this.userAircraft) { add(this.userAircraft.origin); add(this.userAircraft.dest); }
    return set;
  }

  chooseValidAircraft(now) {
    const candidates = this.aircraft.filter(ac => !this.isUserCallsign(ac.callsign));
    if (!candidates.length) return null;
    candidates.sort((a,b) => (a.nextActionAt || 0) - (b.nextActionAt || 0));
    return candidates.find(ac => now >= (ac.nextActionAt || 0)) || candidates[0];
  }

  internalController(ac, text, meta={}) {
    const ev = { type:'controller_internal', role:'atc', callsign:ac.callsign, spokenCallsign:ac.spokenCallsign, text, meta:{ controllerScope:'ai_traffic', silentController:true, ...meta }, t:Date.now() };
    this.log('INTERNAL_ATC', text, ev);
    this.emit('radio', ev);
    return ev;
  }

  pilotReadback(ac, text, meta={}) {
    return this.radio('pilot', ac, text, { readbackOnly:true, requiresAtcAnswer:false, ...meta });
  }

  stepAircraft(ac, now) {
    const runway = ac.assignedRunway || '07';
    switch (ac.phase) {
      case 'PRE_FLIGHT': {
        ac.clearance.hasInitialClearance = true; ac.phase = 'PUSHBACK'; ac.nextActionAt = now + this.wait(45000);
        const clearance = Phrase.clearance(ac, ac.route, runway, ac.assignedAltitude, ac.squawk);
        this.internalController(ac, clearance, { squawkAllowed:true, clearanceIssued:true });
        this.pilotReadback(ac, `${clearance}, ${ac.spokenCallsign}.`, { phase:'clearance_readback' }); break;
      }
      case 'PUSHBACK': {
        ac.phase = 'TAXI_OUT'; ac.nextActionAt = now + this.wait(65000);
        const taxi = Phrase.taxiOut(ac, runway, 'Alpha');
        this.internalController(ac, taxi, { squawkAllowed:false, taxiIssued:true });
        this.pilotReadback(ac, `Taxi to runway ${runway} via Alpha, hold short runway ${runway}, ${ac.spokenCallsign}.`, { phase:'taxi_readback' }); break;
      }
      case 'TAXI_OUT': {
        ac.phase = 'HOLD_SHORT'; ac.nextActionAt = now + this.wait(50000);
        this.pilotReadback(ac, `${ac.spokenCallsign}, holding short runway ${runway}.`, { phase:'holding_short_report' }); break;
      }
      case 'HOLD_SHORT': {
        const can = this.runwaySequencer.canUseRunway(ac.origin, runway, ac.id);
        if (!can.ok) {
          ac.nextActionAt = now + this.wait(45000);
          const hold = Phrase.holdShort(ac, runway, `Traffic ${can.existing.callsign} using the runway`);
          this.internalController(ac, hold, { runwayBlocked:true });
          this.pilotReadback(ac, `Holding short runway ${runway}, ${ac.spokenCallsign}.`, { phase:'hold_short_readback' }); break;
        }
        this.runwaySequencer.reserve({ airport: ac.origin, runway, aircraftId: ac.id, callsign: ac.callsign, type:'departure', ttlMs: 120000 });
        ac.clearance.takeoffCleared = true; ac.phase = 'TAKEOFF'; ac.position.groundSpeed = 140; ac.position.verticalSpeed = 1500; ac.nextActionAt = now + this.wait(50000);
        const takeoff = Phrase.takeoff(ac, runway);
        this.internalController(ac, takeoff, { squawkAllowed:false, runwayReserved:true });
        this.pilotReadback(ac, `Cleared for takeoff runway ${runway}, ${ac.spokenCallsign}.`, { phase:'takeoff_readback' }); break;
      }
      case 'TAKEOFF': {
        this.runwaySequencer.release(ac.origin, runway, ac.id); ac.phase = 'CLIMB'; ac.position.alt = 1500; ac.position.groundSpeed = 220; ac.nextActionAt = now + this.wait(90000);
        this.pilotReadback(ac, `${ac.spokenCallsign}, passing one thousand five hundred for ${ac.assignedAltitude}.`, { phase:'departure_checkin' }); break;
      }
      case 'CLIMB': { ac.phase = 'ENROUTE'; ac.position.alt = ac.assignedAltitude; ac.position.verticalSpeed = 0; ac.position.groundSpeed = 280; ac.nextActionAt = now + this.wait(120000); this.internalController(ac, `${ac.spokenCallsign}, radar contact, proceed on course.`); this.pilotReadback(ac, `Proceeding on course, ${ac.spokenCallsign}.`, { phase:'course_readback' }); break; }
      case 'ENROUTE': { ac.phase = 'DESCENT'; ac.position.verticalSpeed = -700; ac.distanceToAirportNm = 25; ac.nextActionAt = now + this.wait(120000); this.internalController(ac, `${ac.spokenCallsign}, descend and maintain three thousand, expect runway ${runway} approach.`); this.pilotReadback(ac, `Descend and maintain three thousand, expect runway ${runway} approach, ${ac.spokenCallsign}.`, { phase:'descent_readback' }); break; }
      case 'DESCENT': { ac.phase = 'APPROACH'; ac.distanceToAirportNm = 8; ac.position.alt = 3000; ac.position.groundSpeed = 180; ac.nextActionAt = now + this.wait(70000); this.internalController(ac, `${ac.spokenCallsign}, cleared visual runway ${runway} approach, report final.`, { squawkAllowed:false }); this.pilotReadback(ac, `Cleared visual runway ${runway} approach, will report final, ${ac.spokenCallsign}.`, { phase:'approach_readback' }); break; }
      case 'APPROACH': { ac.phase = 'FINAL'; ac.distanceToAirportNm = 4; ac.nextActionAt = now + this.wait(60000); this.pilotReadback(ac, `${ac.spokenCallsign}, final runway ${runway}.`, { phase:'final_report' }); break; }
      case 'FINAL': {
        const can = this.runwaySequencer.canUseRunway(ac.dest, runway, ac.id);
        if (!can.ok) { ac.nextActionAt = now + this.wait(30000); const cont = Phrase.continueFinal(ac, runway, `traffic ${can.existing.callsign} on the runway`); this.internalController(ac, cont); this.pilotReadback(ac, `Continuing final runway ${runway}, ${ac.spokenCallsign}.`, { phase:'continue_final_readback' }); break; }
        this.runwaySequencer.reserve({ airport: ac.dest, runway, aircraftId: ac.id, callsign: ac.callsign, type:'landing', ttlMs: 150000 });
        ac.phase = 'LANDING'; ac.clearance.landingCleared = true; ac.nextActionAt = now + this.wait(55000); const land = Phrase.land(ac, runway); this.internalController(ac, land, { squawkAllowed:false, runwayReserved:true }); this.pilotReadback(ac, `Cleared to land runway ${runway}, ${ac.spokenCallsign}.`, { phase:'landing_readback' }); break;
      }
      case 'LANDING': { this.runwaySequencer.release(ac.dest, runway, ac.id); ac.phase = 'TAXI_IN'; ac.position.groundSpeed = 20; ac.position.alt = 0; ac.nextActionAt = now + this.wait(70000); const taxiIn = Phrase.taxiIn(ac, 'ramp', 'Alpha'); this.internalController(ac, taxiIn, { squawkAllowed:false }); this.pilotReadback(ac, `Taxi to the ramp via Alpha, ${ac.spokenCallsign}.`, { phase:'taxi_in_readback' }); break; }
      case 'TAXI_IN': { ac.phase = 'SHUTDOWN'; ac.nextActionAt = now + this.wait(120000); this.internalController(ac, `${ac.spokenCallsign}, monitor ramp, good day.`); this.pilotReadback(ac, `Monitor ramp, good day, ${ac.spokenCallsign}.`, { phase:'ramp_readback' }); break; }
      default: ac.nextActionAt = now + this.wait(120000);
    }
  }
}
module.exports = { TrafficOrchestrator };
