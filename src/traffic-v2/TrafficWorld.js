'use strict';

const { EventEmitter } = require('events');
const { SquawkManager } = require('./SquawkManager');
const { RouteProcedureResolver } = require('./RouteProcedureResolver');
const { RadioQueue } = require('./RadioQueue');
const { AdsbSimulator } = require('./AdsbSimulator');
const { AircraftStateMachine } = require('./AircraftStateMachine');
const { normalizeIcao } = require('./utils');

const DEFAULT_CALLSIGNS = [
  ['DAL422', 'Delta four two two'],
  ['AAL1842', 'American eighteen forty two'],
  ['JBU681', 'JetBlue six eighty one'],
  ['UAL915', 'United niner fifteen'],
  ['N172SP', 'November one seven two Sierra Papa'],
  ['SWA2381', 'Southwest twenty three eighty one']
];

class TrafficWorld extends EventEmitter {
  constructor({ airports, routes, schedules, config, log } = {}) {
    super();

    this.config = config || {};
    this.log = log || (() => {});
    this.aircraft = new Map();
    this.running = false;

    this.squawks = new SquawkManager();

    this.resolver = new RouteProcedureResolver({
      airports,
      routes,
      schedules,
      log
    });

    this.radio = new RadioQueue({ log });
    this.adsb = new AdsbSimulator();

    this.tickTimer = null;
    this.tickMs = Number(this.config.trafficV2TickMs || 5000);
  }

  start({
    airport = 'KMCO',
    origin,
    dest = 'KJFK',
    runway = '36R',
    route,
    density = 4,
    userFrequency
  } = {}) {
    this.stop(false);

    this.running = true;
    this.aircraft.clear();

    const count = Math.max(1, Math.min(12, Number(density || 4)));

    const userAirport = normalizeIcao(airport || origin, 'KMCO');
    const userOrigin = normalizeIcao(origin || airport, userAirport);
    const userDestination = normalizeIcao(dest, 'KJFK');

    this.radio.setUserFrequency(
      userFrequency ||
      this.config.defaultUserFrequency ||
      this.defaultFrequencies(userAirport).ground ||
      '121.90'
    );

    for (let i = 0; i < count; i += 1) {
      const [callsign, spokenCallsign] =
        DEFAULT_CALLSIGNS[i % DEFAULT_CALLSIGNS.length];

      const aiPlan = this.buildAiFlightPlan({
        airport: userAirport,
        userOrigin,
        userDestination,
        userRoute: route,
        runway,
        callsign,
        index: i
      });

      this.addAircraft({
        callsign,
        spokenCallsign,
        origin: aiPlan.origin,
        destination: aiPlan.destination,
        runway: aiPlan.runway || runway,
        route: aiPlan.route,
        index: i,
        source: aiPlan.source
      });
    }

    this.tickTimer = setInterval(() => this.tick(), this.tickMs);
    this.tick();

    return this.snapshot();
  }

  stop(emit = true) {
    this.running = false;

    if (this.tickTimer) {
      clearInterval(this.tickTimer);
    }

    this.tickTimer = null;

    if (emit) {
      this.emit('state', this.snapshot());
    }
  }

  buildAiFlightPlan({
    airport,
    userOrigin,
    userDestination,
    userRoute,
    runway,
    callsign,
    index = 0
  } = {}) {
    const sessionAirport = normalizeIcao(airport || userOrigin, 'KMCO');

    /*
      Critical design rule:
      The user's route belongs to the user's ATC session only.
      AI traffic must never inherit the user's active route.
      userRoute is intentionally not used below.
    */
    void userDestination;
    void userRoute;

    const aiPairs = this.aiCityPairsForAirport(sessionAirport);

    const selected = aiPairs[index % aiPairs.length] || {
      origin: sessionAirport,
      destination: this.defaultAiDestination(sessionAirport)
    };

    const aiOrigin = normalizeIcao(
      selected.origin || sessionAirport,
      sessionAirport
    );

    const aiDestination = normalizeIcao(
      selected.destination || this.defaultAiDestination(aiOrigin),
      this.defaultAiDestination(aiOrigin)
    );

    const aiRunway =
      selected.runway ||
      runway ||
      this.defaultRunwayForAirport(aiOrigin);

    const aiRoute = this.buildAiRouteForAircraft({
      airport: sessionAirport,
      origin: aiOrigin,
      dest: aiDestination,
      runway: aiRunway,
      callsign,
      index
    });

    return {
      origin: aiOrigin,
      destination: aiDestination,
      runway: aiRunway,
      route: aiRoute,
      source: 'traffic-v2-ai-independent-route'
    };
  }

  aiCityPairsForAirport(airport) {
    const a = normalizeIcao(airport);

    /*
      Starter AI city pairs.
      These are independent from the user flight plan.
      Later these can be expanded from OpenFlights city-pairs,
      AIP schedules, or CSV schedules, but not from the user route.
    */
    if (a === 'KMCO') {
      return [
        { origin: 'KMCO', destination: 'KATL', runway: '36R' },
        { origin: 'KMCO', destination: 'KMIA', runway: '36R' },
        { origin: 'KMCO', destination: 'KBWI', runway: '36R' },
        { origin: 'KMCO', destination: 'KEWR', runway: '36R' },
        { origin: 'KMCO', destination: 'KJAX', runway: '36R' },
        { origin: 'KMCO', destination: 'KTPA', runway: '36R' }
      ];
    }

    if (a === 'TKPK') {
      return [
        { origin: 'TKPK', destination: 'TAPA', runway: '07' },
        { origin: 'TKPK', destination: 'TNCM', runway: '07' },
        { origin: 'TKPK', destination: 'TFFR', runway: '07' },
        { origin: 'TKPK', destination: 'TJSJ', runway: '07' },
        { origin: 'TKPK', destination: 'TBPB', runway: '07' },
        { origin: 'TKPK', destination: 'TAPA', runway: '07' }
      ];
    }

    if (a === 'TAPA') {
      return [
        { origin: 'TAPA', destination: 'TKPK', runway: '07' },
        { origin: 'TAPA', destination: 'TNCM', runway: '07' },
        { origin: 'TAPA', destination: 'TFFR', runway: '07' },
        { origin: 'TAPA', destination: 'TJSJ', runway: '07' },
        { origin: 'TAPA', destination: 'TBPB', runway: '07' },
        { origin: 'TAPA', destination: 'TKPK', runway: '07' }
      ];
    }

    return [
      {
        origin: a,
        destination: this.defaultAiDestination(a),
        runway: this.defaultRunwayForAirport(a)
      }
    ];
  }

  defaultAiDestination(origin) {
    const o = normalizeIcao(origin);

    if (o === 'KMCO') return 'KATL';
    if (o === 'TKPK') return 'TAPA';
    if (o === 'TAPA') return 'TKPK';

    return 'KJFK';
  }

  defaultRunwayForAirport(airport) {
    const a = normalizeIcao(airport);

    if (a === 'TKPK') return '07';
    if (a === 'TAPA') return '07';
    if (a === 'KMCO') return '36R';

    return '09';
  }

  buildAiRouteForAircraft({
    airport,
    origin,
    dest,
    runway,
    callsign,
    index = 0
  } = {}) {
    const o = normalizeIcao(origin || airport, 'KMCO');
    const d = normalizeIcao(
      dest || this.defaultAiDestination(o),
      this.defaultAiDestination(o)
    );

    const cs = String(callsign || '').toUpperCase();

    /*
      GA / N-number logic:
      N172SP should not fly an airline SID like MZULO3.
      Keep it simple GA/VFR/light IFR style.
    */
    if (cs.startsWith('N')) {
      if (o === 'KMCO' && d === 'KJAX') {
        return 'DCT OMN DCT CRG';
      }

      if (o === 'KMCO') {
        return 'DCT OMN DCT CRG';
      }

      if (o === 'TKPK') {
        return 'DCT SKB DCT ANU';
      }

      return `DCT ${this.shortFixName(d)}`;
    }

    /*
      Caribbean starter AI route skeletons.
      These are not copied from the user's route.
    */
    if (o === 'TKPK' && d === 'TAPA') {
      return 'SKB DCT ANU';
    }

    if (o === 'TAPA' && d === 'TKPK') {
      return 'ANU DCT SKB';
    }

    if (o === 'TKPK' && d === 'TNCM') {
      return 'SKB DCT PJM';
    }

    if (o === 'TKPK' && d === 'TFFR') {
      return 'SKB DCT ANU DCT PTP';
    }

    if (o === 'TKPK' && d === 'TJSJ') {
      return 'SKB DCT ANU DCT SJU';
    }

    if (o === 'TKPK' && d === 'TBPB') {
      return 'SKB DCT ANU DCT BGI';
    }

    if (o === 'TAPA' && d === 'TNCM') {
      return 'ANU DCT PJM';
    }

    if (o === 'TAPA' && d === 'TFFR') {
      return 'ANU DCT PTP';
    }

    if (o === 'TAPA' && d === 'TJSJ') {
      return 'ANU DCT SJU';
    }

    if (o === 'TAPA' && d === 'TBPB') {
      return 'ANU DCT BGI';
    }

    /*
      KMCO starter AI route logic.
      These are AI traffic routes only.
      They do not affect the user flight plan.
    */
    if (o === 'KMCO' && d === 'KJFK') {
      return 'MZULO3 ETECK DCT PELCN Y309 FLRDA DCT SAGGY DCT CHIEZ Q161 KALDA Q108 SIE CAMRN5';
    }

    if (o === 'KMCO' && d === 'KATL') {
      return 'MZULO3 ETECK DCT PELCN DCT IRQ DCT ATL';
    }

    if (o === 'KMCO' && d === 'KMIA') {
      return 'MZULO3 DCT MLB DCT FLL DCT MIA';
    }

    if (o === 'KMCO' && d === 'KBWI') {
      return 'MZULO3 ETECK DCT PELCN Y309 FLRDA DCT CHIEZ Q161 SIE';
    }

    if (o === 'KMCO' && d === 'KEWR') {
      return 'MZULO3 ETECK DCT PELCN Y309 FLRDA DCT CHIEZ Q161 SIE';
    }

    if (o === 'KMCO' && d === 'KJAX') {
      return 'DCT OMN DCT CRG';
    }

    if (o === 'KMCO' && d === 'KTPA') {
      return 'DCT LAL DCT PIE';
    }

    /*
      Generic fallback.
      Keep it simple and safe.
    */
    return `${this.shortFixName(o)} DCT ${this.shortFixName(d)}`;
  }

  shortFixName(icao) {
    const v = normalizeIcao(icao || '').toUpperCase();

    if (v.startsWith('K') && v.length === 4) return v.slice(1);
    if (v.startsWith('T') && v.length === 4) return v.slice(1);

    return v || 'DCT';
  }

  addAircraft({
    callsign,
    spokenCallsign,
    origin,
    destination,
    runway,
    route,
    index = 0,
    source = 'traffic-v2-ai'
  }) {
    const id = `ai_${String(callsign).toLowerCase()}`;
    const squawk = this.squawks.assign(callsign);

    const routeState = this.resolver.resolveRoute({
      origin,
      dest: destination,
      route,
      runway
    });

    const initialAltitude = origin === 'KMCO' ? 5000 : 6000;

    const aircraft = {
      id,
      source,
      callsign,
      spokenCallsign,
      squawk,
      origin,
      destination,
      runway,
      gate: `A${10 + index}`,
      phase: index % 2 === 0 ? 'PRE_FLIGHT' : 'TAXI_OUT',
      phaseStartedAt: Date.now(),
      routeState,
      initialAltitude,
      assignedAltitude: initialAltitude,
      cruiseAltitude: this.defaultCruiseAltitude({
        origin,
        destination,
        index
      }),
      heading: runway && String(runway).startsWith('36') ? 360 : 90,
      frequencies: this.defaultFrequencies(origin),
      radioCooldownUntil: 0,
      adsb: null
    };

    aircraft.frequency =
      aircraft.frequencies.ground ||
      aircraft.frequencies.clearance ||
      '121.90';

    aircraft.controller =
      aircraft.frequencies.groundName ||
      aircraft.frequencies.clearanceName ||
      'Ground';

    aircraft.adsb = this.adsb.createTarget(aircraft);

    this.normalizeGroundStateIfNeeded(aircraft);

    this.aircraft.set(id, aircraft);

    return aircraft;
  }

  defaultCruiseAltitude({ origin, destination, index = 0 } = {}) {
    const o = normalizeIcao(origin);
    const d = normalizeIcao(destination);

    if (o === 'KMCO' && d === 'KTPA') return 12000;
    if (o === 'KMCO' && d === 'KJAX') return 18000;

    if (o === 'TKPK' || o === 'TAPA') {
      return 16000 + (index % 3) * 2000;
    }

    return 30000 + (index % 4) * 2000;
  }

  defaultFrequencies(origin) {
    const o = normalizeIcao(origin);

    if (o === 'KMCO') {
      return {
        clearance: '121.80',
        clearanceName: 'Orlando Clearance',
        ground: '121.80',
        groundName: 'Orlando Ground',
        tower: '124.30',
        towerName: 'Orlando Tower',
        departure: '119.40',
        departureName: 'Orlando Departure',
        approach: '119.40',
        approachName: 'Orlando Approach',
        center: '125.70',
        centerName: 'Jacksonville Center'
      };
    }

    if (o === 'TAPA') {
      return {
        clearance: '121.90',
        clearanceName: 'V.C. Bird Clearance',
        ground: '121.90',
        groundName: 'V.C. Bird Ground',
        tower: '118.20',
        towerName: 'V.C. Bird Tower',
        departure: '119.10',
        departureName: 'V.C. Bird Departure',
        approach: '119.10',
        approachName: 'V.C. Bird Approach',
        center: '128.70',
        centerName: 'Piarco Center'
      };
    }

    if (o === 'TKPK') {
      return {
        clearance: '121.90',
        clearanceName: 'Robert L. Bradshaw Clearance',
        ground: '121.90',
        groundName: 'Robert L. Bradshaw Ground',
        tower: '118.30',
        towerName: 'Robert L. Bradshaw Tower',
        departure: '119.10',
        departureName: 'St. Kitts Departure',
        approach: '119.10',
        approachName: 'St. Kitts Approach',
        center: '128.70',
        centerName: 'Piarco Center'
      };
    }

    return {
      clearance: '121.90',
      clearanceName: 'Clearance',
      ground: '121.90',
      groundName: 'Ground',
      tower: '118.30',
      towerName: 'Tower',
      departure: '119.10',
      departureName: 'Departure',
      approach: '119.10',
      approachName: 'Approach',
      center: '125.70',
      centerName: 'Center'
    };
  }

  setUserFrequency(frequency) {
    this.radio.setUserFrequency(frequency);
    this.emit('state', this.snapshot());
  }

  setAudioLock({ source = 'unknown', busy = false } = {}) {
    this.radio.setBusy(source, busy);

    const next = this.radio.releaseNext();

    if (next) {
      this.radio.setBusy('ai', true);
      this.emit('radio', next);
    }

    this.emit('queue', this.radio.snapshot());
  }

  notifyAudioFinished() {
    this.radio.setBusy(null, false);
    this.releaseQueue();
  }

  releaseQueue() {
    const next = this.radio.releaseNext();

    if (next) {
      this.radio.setBusy('ai', true);
      this.emit('radio', next);
    }

    this.emit('queue', this.radio.snapshot());
  }

  handleAiAtcInstruction(instruction = {}) {
    const callsign = String(instruction.callsign || '').toUpperCase();

    const ac = Array.from(this.aircraft.values()).find((a) => {
      return a.callsign === callsign || a.id === instruction.aircraft_id;
    });

    if (!ac) {
      return {
        ok: false,
        error: 'aircraft not found'
      };
    }

    const sm = new AircraftStateMachine({
      aircraft: ac,
      resolver: this.resolver,
      log: this.log
    });

    return this.queueRadio(
      sm.applyAtcInstruction(instruction)
    );
  }

  queueRadio(event) {
    if (!event) {
      return {
        ok: false,
        error: 'no radio event'
      };
    }

    const result = this.radio.enqueue(event);

    if (result.queued) {
      this.emit('queue', this.radio.snapshot());
    }

    const next = this.radio.releaseNext();

    if (next) {
      this.radio.setBusy('ai', true);
      this.emit('radio', next);
    }

    return {
      ok: true,
      ...result,
      queue: this.radio.snapshot()
    };
  }

  tick() {
    if (!this.running) return;

    const dt = this.tickMs / 1000;

    for (const ac of this.aircraft.values()) {
      this.normalizeGroundStateIfNeeded(ac);

      this.adsb.tick(ac, dt);

      this.normalizeGroundStateIfNeeded(ac);

      if (
        Date.now() - (ac.phaseStartedAt || Date.now()) >
        this.phaseDwell(ac.phase)
      ) {
        const sm = new AircraftStateMachine({
          aircraft: ac,
          resolver: this.resolver,
          log: this.log
        });

        sm.advancePhase();
        this.normalizeGroundStateIfNeeded(ac);
      }

      if (Date.now() > (ac.radioCooldownUntil || 0)) {
        const sm = new AircraftStateMachine({
          aircraft: ac,
          resolver: this.resolver,
          log: this.log
        });

        const ev = sm.nextTransmission();

        if (ev) {
          this.queueRadio(ev);
          ac.radioCooldownUntil =
            Date.now() + this.radioCooldown(ac.phase);
        }
      }
    }

    this.emit('adsb', this.adsbPacket());
    this.emit('state', this.snapshot());
  }

  normalizeGroundStateIfNeeded(ac) {
    if (!ac || !ac.adsb) return;

    const groundPhases = new Set([
      'PRE_FLIGHT',
      'CLEARANCE',
      'PUSHBACK',
      'TAXI_OUT',
      'HOLD_SHORT',
      'RUNWAY_EXIT',
      'TAXI_IN',
      'GATE_ARRIVAL',
      'SHUTDOWN'
    ]);

    if (!groundPhases.has(ac.phase)) return;

    if (ac.phase === 'TAXI_OUT' || ac.phase === 'TAXI_IN') {
      ac.adsb.altitude = 0;
      ac.adsb.verticalRate = 0;
      ac.adsb.onGround = true;

      if (!ac.adsb.groundSpeed || ac.adsb.groundSpeed > 35) {
        ac.adsb.groundSpeed = 14;
      }

      return;
    }

    ac.adsb.altitude = 0;
    ac.adsb.groundSpeed = 0;
    ac.adsb.verticalRate = 0;
    ac.adsb.onGround = true;

    if (ac.phase === 'SHUTDOWN') {
      ac.frequency = ac.frequencies?.ground || '121.90';
      ac.controller = ac.frequencies?.groundName || 'Ground';
    }
  }

  phaseDwell(phase) {
    return (
      {
        PRE_FLIGHT: 18000,
        CLEARANCE: 14000,
        PUSHBACK: 18000,
        TAXI_OUT: 32000,
        HOLD_SHORT: 18000,
        DEPARTURE_ROLL: 12000,
        INITIAL_CLIMB: 26000,
        SID_CLIMB: 45000,
        ENROUTE: 65000,
        DESCENT: 45000,
        STAR_ARRIVAL: 45000,
        APPROACH: 32000,
        LANDING: 16000,
        RUNWAY_EXIT: 16000,
        TAXI_IN: 28000,
        GATE_ARRIVAL: 12000,
        SHUTDOWN: 60000
      }[phase] || 30000
    );
  }

  radioCooldown(phase) {
    if (phase === 'ENROUTE') return 45000;

    if (['TAXI_OUT', 'SID_CLIMB', 'STAR_ARRIVAL'].includes(phase)) {
      return 26000;
    }

    return 18000;
  }

  adsbPacket() {
    return {
      type: 'traffic_v2_adsb',
      aircraft: Array.from(this.aircraft.values()).map((a) => ({
        id: a.id,
        source: a.source,
        callsign: a.callsign,
        squawk: a.squawk,
        phase: a.phase,
        origin: a.origin,
        destination: a.destination,
        frequency: a.frequency,
        controller: a.controller,
        routeState: a.routeState,
        adsb: a.adsb
      }))
    };
  }

  snapshot() {
    return {
      ok: true,
      version: 'traffic-v2.0.2-ai-routes-independent-ga-fixed',
      running: this.running,
      aircraftCount: this.aircraft.size,
      aircraft: Array.from(this.aircraft.values()).map((a) => ({
        id: a.id,
        source: a.source,
        callsign: a.callsign,
        spokenCallsign: a.spokenCallsign,
        squawk: a.squawk,
        phase: a.phase,
        origin: a.origin,
        destination: a.destination,
        runway: a.runway,
        gate: a.gate,
        frequency: a.frequency,
        controller: a.controller,
        routeState: a.routeState,
        assignedAltitude: a.assignedAltitude,
        cruiseAltitude: a.cruiseAltitude,
        adsb: a.adsb
      })),
      radio: this.radio.snapshot(),
      squawks: this.squawks.snapshot()
    };
  }
}

module.exports = {
  TrafficWorld
};
