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
    this.userPttTimer = null;
    this.radioRetryTimer = null;
    this.userPhase = String(config.userPhase || config.phase || 'preflight').toLowerCase();
    this.userFrequency = String(config.userFrequency || config.frequency || 'clearance').toLowerCase();
    this.userControllerRole = String(config.userControllerRole || config.controllerRole || 'clearance').toLowerCase();
    this.pendingAiRequests = new Map();
    this.aiAtcBridgeRequired = config.aiAtcBridgeRequired !== false;
    this.aiAtcRequestTimeoutMs = Number(config.aiAtcRequestTimeoutMs || 30000);
    this.aiAtcMaxPending = Number(config.aiAtcMaxPending || 3);
  }

  setUserContext(data = {}) {
    const phase = data.phase || data.userPhase || data.flightPhase;
    const frequency = data.frequency || data.userFrequency || data.activeFrequency;
    const role = data.controllerRole || data.userControllerRole || data.facility || data.controller || data.radioRole;
    if (phase) this.userPhase = String(phase).toLowerCase();
    if (frequency) this.userFrequency = String(frequency).toLowerCase();
    if (role) this.userControllerRole = String(role).toLowerCase();
    this.log('WORLD', `User context synced: phase=${this.userPhase} role=${this.userControllerRole} freq=${this.userFrequency}`, { phase:this.userPhase, controllerRole:this.userControllerRole, frequency:this.userFrequency });
    return { phase:this.userPhase, controllerRole:this.userControllerRole, frequency:this.userFrequency };
  }

  setUserAircraft(data = {}) {
    this.setUserContext(data);
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
    const hold = Math.max(1500, Number(ms || this.config.userPttHoldMs || 4500));
    if (this.userPttTimer) { clearTimeout(this.userPttTimer); this.userPttTimer = null; }
    this.userPttActive = !!active;
    if (active) {
      this.setUserPriority(hold, 'PTT active');
      // v1.9.1: never let PTT stay latched forever if the frontend only sends a PTT-active event.
      this.userPttTimer = setTimeout(() => {
        this.userPttActive = false;
        this.log('WORLD', 'User PTT auto-released after hold window.', { holdMs: hold });
        this.processRadioQueue();
      }, hold + 250);
    } else {
      this.log('WORLD', 'User PTT released by frontend.', {});
      this.processRadioQueue();
    }
  }

  scheduleRadioRetry(delayMs=1500) {
    if (this.radioRetryTimer) return;
    const delay = Math.max(500, Math.min(Number(delayMs || 1500), 10000));
    this.radioRetryTimer = setTimeout(() => {
      this.radioRetryTimer = null;
      this.processRadioQueue();
    }, delay);
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
        // Drop pending AI pilot/controller chatter only when explicitly requested.
        const before = this.radioQueue.length;
        this.radioQueue = this.radioQueue.filter(ev => ev.meta && ev.meta.mustKeep);
        const dropped = before - this.radioQueue.length;
        if (dropped > 0) this.log('WORLD', `Dropped ${dropped} queued AI radio items during user priority window.`, { userPriorityUntil:this.userPriorityUntil });
      } else if (this.radioQueue.length) {
        this.log('WORLD', `AI radio queued but waiting for user priority/PTT release.`, { queueDepth:this.radioQueue.length, userPttActive:this.userPttActive, userPriorityUntil:this.userPriorityUntil });
      }
      this.scheduleRadioRetry(Math.max(750, (this.userPriorityUntil || now) - now + 350));
      return;
    }
    if (!force && now - this.lastRadioAt < this.radioMinGapMs) {
      this.scheduleRadioRetry(this.radioMinGapMs - (now - this.lastRadioAt) + 100);
      return;
    }
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
    this.setUserContext(opts);
    if (opts.userCallsign || opts.callsign || opts.flightCallsign) this.setUserAircraft({ callsign: opts.userCallsign || opts.callsign || opts.flightCallsign, origin: opts.origin || this.airport, dest: opts.dest, runway: opts.runway, phase: opts.phase, frequency: opts.frequency, controllerRole: opts.controllerRole });
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
    this.alignAircraftToUserContext();
    this.running = true;
    this.lastRadioAt = 0;
    this.radioQueue = [];
    this.pendingAiRequests.clear();
    this.nextGlobalActionAt = Date.now() + this.randomBetween(2500, 6500);
    this.log('SYSTEM', `Backend AI scoped traffic started for ${this.airport}. ${this.aircraft.length} aircraft spawned. scope=${[...this.scopeAirports].join('/') || 'local'} radioEvent=${this.radioEventMinMs}-${this.radioEventMaxMs}ms maxQueue=${this.maxRadioQueue}`);
    this.timer = setInterval(() => this.tick(), opts.tickMs || 1000);
    return this.snapshot();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null; this.running = false;
    if (this.aircraft.length) this.log('SYSTEM', 'Backend AI traffic stopped.');
    this.aircraft = []; this.radioQueue = []; this.pendingAiRequests.clear();
  }

  snapshot() { return { running:this.running, airport:this.airport, density:this.density, aircraft:this.aircraft, runwayReservations:this.runwaySequencer.snapshot(), radioQueueDepth:this.radioQueue.length, maxRadioQueue:this.maxRadioQueue, radioMinGapMs:this.radioMinGapMs, radioEventMinMs:this.radioEventMinMs, radioEventMaxMs:this.radioEventMaxMs, scopeAirports:[...this.scopeAirports], pausedForNoClients:this.pausedForNoClients, oneWorldMode:this.oneWorldMode, trafficAtcAudio:!!this.config.trafficAtcAudio, aiPilotAudio:this.config.aiPilotAudio!==false, userAircraft:this.userAircraft, userCallsigns:[...this.userCallsigns], userPriorityActive:Date.now()<this.userPriorityUntil||this.userPttActive, userPriorityUntil:this.userPriorityUntil, userPhase:this.userPhase, userControllerRole:this.userControllerRole, userFrequency:this.userFrequency, allowedAiPhases:this.allowedPhasesForUser(), pendingAiRequests:[...this.pendingAiRequests.values()].map(p=>p.req), aiAtcBridgeRequired:this.aiAtcBridgeRequired, logs:this.logs.slice(0,50) }; }
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

  normalizeContextText(v='') { return String(v || '').toLowerCase().replace(/[^a-z0-9_. -]/g, ' '); }

  allowedPhasesForUser() {
    const phase = this.normalizeContextText(this.userPhase);
    const role = this.normalizeContextText(this.userControllerRole + ' ' + this.userFrequency);
    const txt = `${phase} ${role}`;
    if (/preflight|clearance|delivery|ifr clearance/.test(txt)) return ['PRE_FLIGHT'];
    if (/push|startup|start|apron/.test(txt)) return ['PUSHBACK'];
    if (/ground|taxi out|taxi-out|taxi|ramp/.test(txt) && !/landing|after|taxi in|taxi-in|gate|stand|fbo/.test(txt)) return ['PUSHBACK','TAXI_OUT'];
    if (/tower|takeoff|departure runway|holding short/.test(txt)) return ['TAXI_OUT','HOLD_SHORT','TAKEOFF'];
    if (/departure|climb/.test(txt)) return ['TAKEOFF','CLIMB'];
    if (/center|enroute|cruise|route/.test(txt)) return ['CLIMB','ENROUTE'];
    if (/approach|descent|arrival/.test(txt)) return ['DESCENT','APPROACH'];
    if (/final|tower arrival|landing|land/.test(txt)) return ['APPROACH','FINAL','LANDING'];
    if (/after landing|taxi in|taxi-in|gate|stand|fbo|ramp/.test(txt)) return ['LANDING','TAXI_IN'];
    return ['PRE_FLIGHT'];
  }

  alignAircraftToUserContext() {
    const allowed = this.allowedPhasesForUser();
    const now = Date.now();
    this.aircraft.forEach((ac, idx) => {
      if (!allowed.includes(ac.phase)) {
        ac.phase = allowed[Math.min(idx, allowed.length - 1)] || allowed[0] || 'PRE_FLIGHT';
        ac.nextActionAt = now + this.randomBetween(this.radioEventMinMs, this.radioEventMaxMs) + idx * 2500;
        if (['PRE_FLIGHT','PUSHBACK','TAXI_OUT','HOLD_SHORT'].includes(ac.phase)) { ac.position.alt = 0; ac.position.groundSpeed = 0; ac.position.verticalSpeed = 0; }
        if (ac.phase === 'DESCENT') { ac.position.alt = Math.min(ac.assignedAltitude || 8000, 10000); ac.distanceToAirportNm = 25; }
        if (ac.phase === 'APPROACH') { ac.position.alt = 3000; ac.distanceToAirportNm = 8; }
        if (ac.phase === 'FINAL') { ac.position.alt = 1500; ac.distanceToAirportNm = 4; }
      }
    });
    this.log('WORLD', `AI traffic scoped to user frequency/phase: ${allowed.join(', ')}`, { userPhase:this.userPhase, controllerRole:this.userControllerRole, frequency:this.userFrequency, allowed });
  }

  chooseValidAircraft(now) {
    const allowed = this.allowedPhasesForUser();
    const candidates = this.aircraft.filter(ac => !this.isUserCallsign(ac.callsign) && allowed.includes(ac.phase));
    if (!candidates.length) { this.alignAircraftToUserContext(); return null; }
    candidates.sort((a,b) => (a.nextActionAt || 0) - (b.nextActionAt || 0));
    return candidates.find(ac => now >= (ac.nextActionAt || 0)) || null;
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

  requestAiInstruction(ac, intent, requestText, suggestedInstruction, readbackText, nextPhase, meta={}) {
    const now = Date.now();
    if (this.pendingAiRequests.size >= this.aiAtcMaxPending) {
      ac.nextActionAt = now + this.randomBetween(this.radioEventMinMs, this.radioEventMaxMs);
      this.log('AI_BRIDGE_HOLD', `AI ATC bridge pending limit reached; holding ${ac.spokenCallsign}.`, { pending:this.pendingAiRequests.size, max:this.aiAtcMaxPending });
      return null;
    }
    const id = `${ac.id}-${intent}-${now}`;
    const req = {
      type:'ai_pilot_request',
      requestId:id,
      callsign:ac.callsign,
      spokenCallsign:ac.spokenCallsign,
      phase:ac.phase,
      intent,
      frequencyScope:this.allowedPhasesForUser().join(','),
      userPhase:this.userPhase,
      userControllerRole:this.userControllerRole,
      userFrequency:this.userFrequency,
      origin:ac.origin,
      dest:ac.dest,
      runway:ac.assignedRunway || '07',
      route:ac.route,
      altitude:ac.assignedAltitude,
      squawk:ac.squawk,
      text:requestText,
      suggestedInstruction,
      suggestedReadback:readbackText,
      nextPhase,
      meta,
      t:now
    };
    ac.pendingRequestId = id;
    ac.nextActionAt = now + this.aiAtcRequestTimeoutMs;
    this.pendingAiRequests.set(id, { req, acId:ac.id, createdAt:now, expiresAt:now+this.aiAtcRequestTimeoutMs });
    this.log('AI_REQUEST', `${ac.spokenCallsign}: ${requestText}`, req);
    this.emit('ai_pilot_request', req);
    this.emit('radio', req);
    return req;
  }

  async handleAiAtcInstruction(data={}) {
    const id = data.requestId || data.id;
    if (!id || !this.pendingAiRequests.has(id)) throw new Error('unknown or expired ai request');
    const pending = this.pendingAiRequests.get(id);
    this.pendingAiRequests.delete(id);
    const ac = this.aircraft.find(a => a.id === pending.acId || a.callsign === data.callsign);
    if (!ac) throw new Error('AI aircraft no longer active');
    const instruction = String(data.instruction || data.atcInstruction || data.text || pending.req.suggestedInstruction || '').trim();
    const readback = String(data.readback || data.aiReadback || pending.req.suggestedReadback || '').trim();
    if (!instruction || !readback) throw new Error('instruction/readback missing');

    this.internalController(ac, instruction, { frontendAtc:true, requestId:id, intent:pending.req.intent, skyEchoCabinAtc:true });
    // Apply state only after the frontend SkyEchoCabin ATC bridge has issued the instruction.
    const nextPhase = data.nextPhase || pending.req.nextPhase;
    if (nextPhase) ac.phase = nextPhase;
    ac.lastInstruction = instruction;
    ac.pendingRequestId = null;
    ac.nextActionAt = Date.now() + this.randomBetween(this.radioEventMinMs, this.radioEventMaxMs);
    this.applyInstructionEffects(ac, pending.req.intent, instruction);
    const ev = this.pilotReadback(ac, readback, { requestId:id, phase:`${pending.req.intent}_readback`, frontendAtc:true, mustKeep:true });
    this.scheduleRadioRetry(750);
    this.log('AI_BRIDGE', `SkyEchoCabin ATC bridged ${pending.req.intent} for ${ac.spokenCallsign}.`, { instruction, readback, nextPhase:ac.phase });
    return { requestId:id, callsign:ac.callsign, phase:ac.phase, instruction, readback, radio:ev };
  }

  applyInstructionEffects(ac, intent, instruction='') {
    const runway = ac.assignedRunway || '07';
    if (intent === 'takeoff_clearance' || /cleared\s+for\s+takeoff/i.test(instruction)) {
      this.runwaySequencer.reserve({ airport: ac.origin, runway, aircraftId: ac.id, callsign: ac.callsign, type:'departure', ttlMs:120000 });
      ac.clearance.takeoffCleared = true; ac.position.groundSpeed = 140; ac.position.verticalSpeed = 1500;
    }
    if (intent === 'landing_clearance' || /cleared\s+to\s+land/i.test(instruction)) {
      this.runwaySequencer.reserve({ airport: ac.dest, runway, aircraftId: ac.id, callsign: ac.callsign, type:'landing', ttlMs:150000 });
      ac.clearance.landingCleared = true;
    }
    if (intent === 'departure_checkin') { this.runwaySequencer.release(ac.origin, runway, ac.id); ac.position.alt = 1500; ac.position.groundSpeed = 220; }
    if (intent === 'taxi_in') { this.runwaySequencer.release(ac.dest, runway, ac.id); ac.position.alt = 0; ac.position.groundSpeed = 20; }
  }

  expirePendingRequests(now=Date.now()) {
    for (const [id, p] of [...this.pendingAiRequests.entries()]) {
      if (now > p.expiresAt) {
        this.pendingAiRequests.delete(id);
        const ac = this.aircraft.find(a => a.id === p.acId);
        if (ac) { ac.pendingRequestId = null; ac.nextActionAt = now + this.randomBetween(this.radioEventMinMs, this.radioEventMaxMs); }
        this.log('AI_BRIDGE_TIMEOUT', `No SkyEchoCabin ATC instruction returned for ${p.req.spokenCallsign}; request expired.`, { requestId:id, intent:p.req.intent });
      }
    }
  }

  aiTextsFor(ac) {
    const runway = ac.assignedRunway || '07';
    const route = ac.route || 'DCT';
    const alt = ac.assignedAltitude || 7000;
    const sq = ac.squawk || '1200';
    const cs = ac.spokenCallsign;
    switch (ac.phase) {
      case 'PRE_FLIGHT':
        return { intent:'ifr_clearance', req:`Clearance, ${cs}, request IFR clearance to ${ac.dest}.`, instr:`${cs}, cleared to ${ac.dest} via ${route}, depart runway ${runway}, climb initially ${alt}, squawk ${sq}.`, rb:`Cleared to ${ac.dest} via ${route}, depart runway ${runway}, climb initially ${alt}, squawk ${sq}, ${cs}.`, next:'PUSHBACK' };
      case 'PUSHBACK':
        return { intent:'taxi_clearance', req:`Ground, ${cs}, ready to taxi.`, instr:`${cs}, taxi to runway ${runway} via Alpha, hold short runway ${runway}.`, rb:`Taxi to runway ${runway} via Alpha, hold short runway ${runway}, ${cs}.`, next:'TAXI_OUT' };
      case 'TAXI_OUT':
        return { intent:'hold_short_report', req:`Tower, ${cs}, holding short runway ${runway}.`, instr:`${cs}, hold short runway ${runway}, traffic on departure.`, rb:`Holding short runway ${runway}, ${cs}.`, next:'HOLD_SHORT' };
      case 'HOLD_SHORT':
        return { intent:'takeoff_clearance', req:`Tower, ${cs}, ready for departure runway ${runway}.`, instr:`${cs}, runway ${runway}, cleared for takeoff, fly runway heading.`, rb:`Cleared for takeoff runway ${runway}, ${cs}.`, next:'TAKEOFF' };
      case 'TAKEOFF':
        return { intent:'departure_checkin', req:`Departure, ${cs}, passing one thousand five hundred for ${alt}.`, instr:`${cs}, radar contact, climb and maintain ${alt}, proceed on course.`, rb:`Climb and maintain ${alt}, proceeding on course, ${cs}.`, next:'CLIMB' };
      case 'CLIMB':
        return { intent:'enroute_instruction', req:`Center, ${cs}, with you level ${alt}.`, instr:`${cs}, roger, proceed on course, report top of descent.`, rb:`Proceeding on course, ${cs}.`, next:'ENROUTE' };
      case 'ENROUTE':
        return { intent:'descent_clearance', req:`Approach, ${cs}, request descent.`, instr:`${cs}, descend and maintain three thousand, expect runway ${runway} approach.`, rb:`Descend and maintain three thousand, expect runway ${runway} approach, ${cs}.`, next:'DESCENT' };
      case 'DESCENT':
        return { intent:'approach_clearance', req:`Approach, ${cs}, airport in sight, request visual runway ${runway}.`, instr:`${cs}, cleared visual runway ${runway} approach, report final.`, rb:`Cleared visual runway ${runway} approach, will report final, ${cs}.`, next:'APPROACH' };
      case 'APPROACH':
        return { intent:'final_report', req:`Tower, ${cs}, final runway ${runway}.`, instr:`${cs}, continue runway ${runway}, traffic departing.`, rb:`Continuing runway ${runway}, ${cs}.`, next:'FINAL' };
      case 'FINAL':
        return { intent:'landing_clearance', req:`Tower, ${cs}, final runway ${runway}.`, instr:`${cs}, runway ${runway}, cleared to land.`, rb:`Cleared to land runway ${runway}, ${cs}.`, next:'LANDING' };
      case 'LANDING':
        return { intent:'taxi_in', req:`Ground, ${cs}, clear of runway ${runway}, request taxi to the ramp.`, instr:`${cs}, taxi to the ramp via Alpha.`, rb:`Taxi to the ramp via Alpha, ${cs}.`, next:'TAXI_IN' };
      case 'TAXI_IN':
        return { intent:'shutdown', req:`Ramp, ${cs}, on blocks.`, instr:`${cs}, monitor ramp, good day.`, rb:`Monitor ramp, good day, ${cs}.`, next:'SHUTDOWN' };
      default:
        return null;
    }
  }

  stepAircraft(ac, now) {
    this.expirePendingRequests(now);
    if (ac.pendingRequestId) return;
    const allowedNow = this.allowedPhasesForUser();
    if (!allowedNow.includes(ac.phase)) {
      ac.nextActionAt = now + this.randomBetween(this.radioEventMinMs, this.radioEventMaxMs);
      return;
    }
    const data = this.aiTextsFor(ac);
    if (!data) { ac.nextActionAt = now + this.wait(120000); return; }
    // Separation guard before asking frontend ATC for runway use.
    const runway = ac.assignedRunway || '07';
    if (data.intent === 'takeoff_clearance') {
      const can = this.runwaySequencer.canUseRunway(ac.origin, runway, ac.id);
      if (!can.ok) {
        data.instr = `${ac.spokenCallsign}, hold short runway ${runway}, traffic ${can.existing.callsign} using the runway.`;
        data.rb = `Holding short runway ${runway}, ${ac.spokenCallsign}.`;
        data.next = 'HOLD_SHORT';
      }
    }
    if (data.intent === 'landing_clearance') {
      const can = this.runwaySequencer.canUseRunway(ac.dest, runway, ac.id);
      if (!can.ok) {
        data.instr = `${ac.spokenCallsign}, continue runway ${runway}, traffic ${can.existing.callsign} on the runway.`;
        data.rb = `Continuing final runway ${runway}, ${ac.spokenCallsign}.`;
        data.next = 'FINAL';
      }
    }
    this.requestAiInstruction(ac, data.intent, data.req, data.instr, data.rb, data.next, { phase:ac.phase, frequencyScope:this.userControllerRole });
  }
}
module.exports = { TrafficOrchestrator };
