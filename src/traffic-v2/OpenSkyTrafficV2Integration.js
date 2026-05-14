'use strict';

const { OpenSkyLiveProvider } = require('./OpenSkyLiveProvider');
const { resolveRegionProfile } = require('../governance/RegionalRuleManager');

function spokenFromCallsign(callsign) {
  const raw = String(callsign || 'Traffic').trim().toUpperCase();
  const m = raw.match(/^([A-Z]{2,3})(\d+)$/);
  const map = { DAL:'Delta', AAL:'American', UAL:'United', JBU:'JetBlue', BAW:'Speedbird', BWA:'Caribbean', WJA:'WestJet', SWA:'Southwest', NKS:'Spirit', FFT:'Frontier' };
  if (m) return `${map[m[1]] || m[1].split('').join(' ')} ${m[2].split('').join(' ')}`;
  if (/^N[0-9A-Z]+$/.test(raw)) return `November ${raw.slice(1).split('').join(' ')}`;
  return raw.split('').join(' ');
}

function inferPhaseFromAdsb(adsb) {
  const alt = Number(adsb?.altitude || 0);
  const gs = Number(adsb?.groundSpeed || 0);
  const vs = Number(adsb?.verticalRate || 0);
  const onGround = !!adsb?.onGround;
  if (onGround && gs < 3) return 'PRE_FLIGHT';
  if (onGround) return 'TAXI_OUT';
  if (alt < 2500 && vs > 300) return 'INITIAL_CLIMB';
  if (vs > 500) return 'SID_CLIMB';
  if (vs < -700 && alt > 8000) return 'DESCENT';
  if (vs < -300 && alt <= 8000) return 'STAR_ARRIVAL';
  if (alt <= 3500 && gs < 220) return 'APPROACH';
  return 'ENROUTE';
}

function frequencyFromPhase(phase, airportFreqs = {}) {
  if (['PRE_FLIGHT','CLEARANCE','PUSHBACK','TAXI_OUT','HOLD_SHORT'].includes(phase)) return airportFreqs.ground || airportFreqs.clearance || '121.90';
  if (['DEPARTURE_ROLL','LANDING','RUNWAY_EXIT'].includes(phase)) return airportFreqs.tower || '118.30';
  if (['INITIAL_CLIMB','SID_CLIMB'].includes(phase)) return airportFreqs.departure || airportFreqs.approach || '119.10';
  if (['DESCENT','STAR_ARRIVAL','APPROACH'].includes(phase)) return airportFreqs.approach || airportFreqs.departure || '119.10';
  return airportFreqs.center || '125.70';
}

function controllerFromPhase(phase, airportFreqs = {}) {
  if (['PRE_FLIGHT','CLEARANCE','PUSHBACK','TAXI_OUT','HOLD_SHORT'].includes(phase)) return airportFreqs.groundName || 'Ground';
  if (['DEPARTURE_ROLL','LANDING','RUNWAY_EXIT'].includes(phase)) return airportFreqs.towerName || 'Tower';
  if (['INITIAL_CLIMB','SID_CLIMB'].includes(phase)) return airportFreqs.departureName || 'Departure';
  if (['DESCENT','STAR_ARRIVAL','APPROACH'].includes(phase)) return airportFreqs.approachName || 'Approach';
  return airportFreqs.centerName || 'Center';
}

function installOpenSkyIntoTrafficWorld(world) {
  world.opensky = world.opensky || new OpenSkyLiveProvider({ env: process.env, log: world.log });
  world.userAircraftState = world.userAircraftState || null;

  world.updateUserAircraftState = function updateUserAircraftState(state = {}) {
    this.userAircraftState = { ...this.userAircraftState, ...state, updatedAt: Date.now() };
    if (state.frequency || state.userFrequency) this.radio.setUserFrequency(state.frequency || state.userFrequency);
    return this.userAircraftState;
  };

  world.syncOpenSkyNearby = async function syncOpenSkyNearby(state = {}) {
    const user = this.updateUserAircraftState(state);
    const lat = Number(user.lat), lon = Number(user.lon);
    const result = await this.opensky.fetchNearby({
      lat,
      lon,
      radiusNm: state.radiusNm || process.env.OPENSKY_RADIUS_NM || 50,
      maxAircraft: state.maxAircraft || process.env.OPENSKY_MAX_AIRCRAFT || 20
    });

    const profile = resolveRegionProfile({ airport: user.airport || user.origin, lat, lon });
    const freqs = this.defaultFrequencies ? this.defaultFrequencies(user.airport || user.origin || 'TAPA') : {};
    let injected = 0;

    for (const live of result.aircraft || []) {
      const id = live.id;
      const existing = this.aircraft.get(id);
      const phase = inferPhaseFromAdsb(live.adsb);
      const ac = existing || {
        id,
        source: 'opensky',
        callsign: live.callsign,
        spokenCallsign: spokenFromCallsign(live.callsign),
        squawk: live.squawk || this.squawks.assign(live.callsign),
        origin: user.origin || user.airport || 'LIVE',
        destination: user.dest || 'LIVE',
        runway: user.runway || '',
        gate: '',
        routeState: this.resolver.resolveRoute({ origin: user.origin || user.airport, dest: user.dest, route: user.route || 'DCT', runway: user.runway }),
        initialAltitude: 6000,
        assignedAltitude: live.adsb.altitude || 6000,
        cruiseAltitude: Math.max(18000, live.adsb.altitude || 24000),
        heading: live.adsb.heading || 0,
        frequencies: freqs,
        radioCooldownUntil: 0
      };

      ac.source = 'opensky';
      ac.icao24 = live.icao24;
      ac.originCountry = live.originCountry;
      ac.category = live.category;
      ac.distanceNm = live.distanceNm;
      ac.phase = phase;
      ac.frequency = frequencyFromPhase(phase, freqs);
      ac.controller = controllerFromPhase(phase, freqs);
      ac.regionalProfile = profile.id;
      ac.adsb = { ...live.adsb, squawk: ac.squawk };
      ac.assignedAltitude = ac.adsb.altitude || ac.assignedAltitude;
      ac.heading = ac.adsb.heading || ac.heading;
      ac.lastOpenSkyAt = Date.now();
      this.aircraft.set(id, ac);
      injected++;
    }

    const staleMs = Number(process.env.OPENSKY_STALE_MS || 180000);
    for (const [id, ac] of this.aircraft.entries()) {
      if (ac.source === 'opensky' && ac.lastOpenSkyAt && Date.now() - ac.lastOpenSkyAt > staleMs) this.aircraft.delete(id);
    }

    this.emit('state', this.snapshot());
    this.emit('adsb', this.adsbPacket());
    return { ok: true, source: 'opensky', regionalProfile: profile.id, injected, result, state: this.snapshot() };
  };

  const originalSnapshot = world.snapshot.bind(world);
  world.snapshot = function snapshotWithOpenSky() {
    const snap = originalSnapshot();
    snap.opensky = this.opensky ? this.opensky.snapshot() : null;
    snap.userAircraftState = this.userAircraftState || null;
    return snap;
  };

  return world;
}

module.exports = { installOpenSkyIntoTrafficWorld, inferPhaseFromAdsb, frequencyFromPhase, controllerFromPhase, spokenFromCallsign };
