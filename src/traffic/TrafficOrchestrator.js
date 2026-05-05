const EventEmitter = require('events');
const { spawnFromSchedules } = require('./SpawnManager');
const { updateKinematics } = require('./AircraftStateMachine');
const Phrase = require('../atc/Phraseology');
const { adsbPacket } = require('./TelemetryBroadcaster');
class TrafficOrchestrator extends EventEmitter {
  constructor({ schedules, routes, airlineRegistry, runwaySequencer, arrivalSequencer, groundSequencer }) {
    super(); this.schedules = schedules; this.routes = routes; this.airlineRegistry = airlineRegistry;
    this.runwaySequencer = runwaySequencer; this.arrivalSequencer = arrivalSequencer; this.groundSequencer = groundSequencer;
    this.aircraft = []; this.running = false; this.timer = null; this.airport = 'TKPK'; this.density = 3; this.logs = [];
  }
  log(type, text, data={}) { const entry = { t: new Date().toISOString(), type, text, data }; this.logs.unshift(entry); this.logs = this.logs.slice(0, 500); this.emit('log', entry); return entry; }
  radio(role, aircraft, text, meta={}) { const ev = { type:'radio', role, callsign: aircraft.callsign, spokenCallsign: aircraft.spokenCallsign, text, meta, t: Date.now() }; this.log(role === 'atc' ? 'ATC' : 'PILOT', text, ev); this.emit('radio', ev); return ev; }
  start(opts={}) { this.stop(); this.airport = opts.airport || this.airport; this.density = Number(opts.density || this.density); this.aircraft = spawnFromSchedules(this.schedules, this.routes, this.airlineRegistry, { density: this.density }); this.running = true; this.log('SYSTEM', `Backend AI traffic started for ${this.airport}. ${this.aircraft.length} aircraft spawned.`); this.timer = setInterval(() => this.tick(), opts.tickMs || 1000); return this.snapshot(); }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; this.running = false; if (this.aircraft.length) this.log('SYSTEM', 'Backend AI traffic stopped.'); this.aircraft = []; }
  snapshot() { return { running:this.running, airport:this.airport, density:this.density, aircraft:this.aircraft, runwayReservations:this.runwaySequencer.snapshot(), logs:this.logs.slice(0,50) }; }
  adsb() { return { type:'adsb_update', aircraft:this.aircraft.map(adsbPacket) }; }
  tick() { const now = Date.now(); this.arrivalSequencer.update(this.aircraft); for (const ac of this.aircraft) { updateKinematics(ac, 1); if (now >= ac.nextActionAt) this.stepAircraft(ac, now); } this.emit('adsb', this.adsb()); }
  stepAircraft(ac, now) {
    const runway = ac.assignedRunway || '07';
    switch (ac.phase) {
      case 'PRE_FLIGHT': {
        ac.clearance.hasInitialClearance = true; ac.phase = 'PUSHBACK'; ac.nextActionAt = now + 12000;
        this.radio('pilot', ac, `${ac.spokenCallsign}, request IFR clearance to ${ac.dest}.`);
        this.radio('atc', ac, Phrase.clearance(ac, ac.route, runway, ac.assignedAltitude, ac.squawk), { squawkAllowed: true }); break;
      }
      case 'PUSHBACK': {
        ac.phase = 'TAXI_OUT'; ac.nextActionAt = now + 15000;
        this.radio('pilot', ac, `${ac.spokenCallsign}, ready to taxi.`);
        this.radio('atc', ac, Phrase.taxiOut(ac, runway, 'Alpha'), { squawkAllowed: false }); break;
      }
      case 'TAXI_OUT': {
        ac.phase = 'HOLD_SHORT'; ac.nextActionAt = now + 12000;
        this.radio('pilot', ac, `${ac.spokenCallsign}, holding short runway ${runway}.`); break;
      }
      case 'HOLD_SHORT': {
        const can = this.runwaySequencer.canUseRunway(ac.origin, runway, ac.id);
        this.radio('pilot', ac, `${ac.spokenCallsign}, ready for departure runway ${runway}.`);
        if (!can.ok) { ac.nextActionAt = now + 30000; this.radio('atc', ac, Phrase.holdShort(ac, runway, `Traffic ${can.existing.callsign} using the runway`)); break; }
        this.runwaySequencer.reserve({ airport: ac.origin, runway, aircraftId: ac.id, callsign: ac.callsign, type:'departure', ttlMs: 90000 });
        ac.clearance.takeoffCleared = true; ac.phase = 'TAKEOFF'; ac.position.groundSpeed = 140; ac.position.verticalSpeed = 1500; ac.nextActionAt = now + 30000;
        this.radio('atc', ac, Phrase.takeoff(ac, runway), { squawkAllowed:false, runwayReserved:true }); break;
      }
      case 'TAKEOFF': {
        this.runwaySequencer.release(ac.origin, runway, ac.id); ac.phase = 'CLIMB'; ac.position.alt = 1500; ac.position.groundSpeed = 220; ac.nextActionAt = now + 30000;
        this.radio('pilot', ac, `${ac.spokenCallsign}, passing one thousand five hundred for ${ac.assignedAltitude}.`); break;
      }
      case 'CLIMB': { ac.phase = 'ENROUTE'; ac.position.alt = ac.assignedAltitude; ac.position.verticalSpeed = 0; ac.position.groundSpeed = 280; ac.nextActionAt = now + 45000; this.radio('atc', ac, `${ac.spokenCallsign}, radar contact, proceed on course.`); break; }
      case 'ENROUTE': { ac.phase = 'DESCENT'; ac.position.verticalSpeed = -700; ac.distanceToAirportNm = 25; ac.nextActionAt = now + 30000; this.radio('atc', ac, `${ac.spokenCallsign}, descend and maintain three thousand, expect runway ${runway} approach.`); break; }
      case 'DESCENT': { ac.phase = 'APPROACH'; ac.distanceToAirportNm = 8; ac.position.alt = 3000; ac.position.groundSpeed = 180; ac.nextActionAt = now + 20000; this.radio('pilot', ac, `${ac.spokenCallsign}, airport in sight, request visual runway ${runway}.`); this.radio('atc', ac, `${ac.spokenCallsign}, cleared visual runway ${runway} approach, report final.`, { squawkAllowed:false }); break; }
      case 'APPROACH': { ac.phase = 'FINAL'; ac.distanceToAirportNm = 4; ac.nextActionAt = now + 20000; this.radio('pilot', ac, `${ac.spokenCallsign}, final runway ${runway}.`); break; }
      case 'FINAL': {
        const can = this.runwaySequencer.canUseRunway(ac.dest, runway, ac.id);
        if (!can.ok) { ac.nextActionAt = now + 15000; this.radio('atc', ac, Phrase.continueFinal(ac, runway, `traffic ${can.existing.callsign} on the runway`)); break; }
        this.runwaySequencer.reserve({ airport: ac.dest, runway, aircraftId: ac.id, callsign: ac.callsign, type:'landing', ttlMs: 120000 });
        ac.phase = 'LANDING'; ac.clearance.landingCleared = true; ac.nextActionAt = now + 30000; this.radio('atc', ac, Phrase.land(ac, runway), { squawkAllowed:false, runwayReserved:true }); break;
      }
      case 'LANDING': { this.runwaySequencer.release(ac.dest, runway, ac.id); ac.phase = 'TAXI_IN'; ac.position.groundSpeed = 20; ac.position.alt = 0; ac.nextActionAt = now + 20000; this.radio('pilot', ac, `${ac.spokenCallsign} clear of runway ${runway}, request taxi to the ramp.`); this.radio('atc', ac, Phrase.taxiIn(ac, 'ramp', 'Alpha'), { squawkAllowed:false }); break; }
      case 'TAXI_IN': { ac.phase = 'SHUTDOWN'; ac.nextActionAt = now + 60000; this.radio('atc', ac, `${ac.spokenCallsign}, monitor ramp, good day.`); break; }
      default: ac.nextActionAt = now + 60000;
    }
  }
}
module.exports = { TrafficOrchestrator };
