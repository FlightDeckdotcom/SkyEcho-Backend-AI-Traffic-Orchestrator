'use strict';

const REGION_PROFILES = {
  FAA_US: {
    id: 'FAA_US',
    appliesTo: ['K'],
    authority: 'FAA / United States AIP',
    phraseology: 'FAA',
    altimeter: 'inHg',
    qnhPhrase: 'altimeter',
    transitionAltitudeFt: 18000,
    flightLevelBeginsFt: 18000,
    releaseModel: 'handoff',
    speedControl: 'FAA',
    sourcePriority: ['airport procedure CSV', 'FAA AIP', 'FAA profile fallback']
  },
  EASA_EUROCONTROL: {
    id: 'EASA_EUROCONTROL',
    appliesToPrefixes: ['E', 'L'],
    authority: 'EASA / EUROCONTROL / State AIP',
    phraseology: 'ICAO_EU',
    altimeter: 'hPa',
    qnhPhrase: 'QNH',
    transitionAltitudeFt: 'state_or_airport_specific',
    transitionLevel: 'state_or_airport_specific',
    releaseModel: 'coordination_release_when_applicable',
    speedControl: 'ICAO',
    sourcePriority: ['airport procedure CSV/AIXM', 'State eAIP', 'EUROCONTROL profile fallback']
  },
  ICAO_CAR: {
    id: 'ICAO_CAR',
    appliesTo: ['T'],
    authority: 'ICAO / Caribbean State AIP / ECCA where applicable',
    phraseology: 'ICAO_CAR',
    altimeter: 'state_specific',
    qnhPhrase: 'QNH_or_altimeter_by_state',
    transitionAltitudeFt: 'state_or_airport_specific',
    releaseModel: 'coordination_release_when_applicable',
    speedControl: 'ICAO',
    sourcePriority: ['airport procedure CSV', 'Caribbean State AIP/ECCA', 'ICAO CAR fallback']
  },
  ICAO_DEFAULT: {
    id: 'ICAO_DEFAULT',
    appliesTo: ['default'],
    authority: 'ICAO / State AIP',
    phraseology: 'ICAO',
    altimeter: 'state_specific',
    qnhPhrase: 'QNH',
    transitionAltitudeFt: 'state_or_airport_specific',
    releaseModel: 'coordination_release_when_applicable',
    speedControl: 'ICAO',
    sourcePriority: ['airport procedure CSV', 'State AIP', 'ICAO fallback']
  }
};

function resolveRegionProfile({ airport, lat, lon } = {}) {
  const icao = String(airport || '').trim().toUpperCase();
  if (/^K[A-Z0-9]{3}$/.test(icao)) return REGION_PROFILES.FAA_US;
  if (/^[EL][A-Z0-9]{3}$/.test(icao)) return REGION_PROFILES.EASA_EUROCONTROL;
  if (/^T[A-Z0-9]{3}$/.test(icao)) return REGION_PROFILES.ICAO_CAR;

  const la = Number(lat), lo = Number(lon);
  if (Number.isFinite(la) && Number.isFinite(lo)) {
    if (la > 18 && la < 72 && lo > -170 && lo < -50) return REGION_PROFILES.FAA_US;
    if (la > 34 && la < 72 && lo > -25 && lo < 45) return REGION_PROFILES.EASA_EUROCONTROL;
    if (la > 5 && la < 30 && lo > -90 && lo < -50) return REGION_PROFILES.ICAO_CAR;
  }
  return REGION_PROFILES.ICAO_DEFAULT;
}

module.exports = { REGION_PROFILES, resolveRegionProfile };
