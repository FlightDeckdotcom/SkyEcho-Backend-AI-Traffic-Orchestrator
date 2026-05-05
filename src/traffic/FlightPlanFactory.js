const { spokenCallsign } = require('../atc/CallsignFormatter');
function makeSquawk(i) { const base = 1200 + ((i * 137) % 6000); return String(base).padStart(4,'0').slice(0,4); }
function makeFlightPlan(row, routes, airlineRegistry, i) {
  const routeRow = routes.find(r => r.origin === row.origin && r.dest === row.dest) || {};
  const route = String(routeRow.route || 'DCT').split(/\s+/).filter(Boolean);
  const rules = row.type || routeRow.rule || 'IFR';
  return {
    id: `ai-${row.callsign.toLowerCase()}-${i}`,
    icao24: `SE${String(i).padStart(4, '0')}`,
    callsign: row.callsign,
    spokenCallsign: spokenCallsign(row.callsign, airlineRegistry),
    type: row.aircraft || 'B738',
    rules,
    origin: row.origin,
    dest: row.dest,
    route,
    assignedAltitude: Number(routeRow.default_alt || (rules === 'VFR' ? 2500 : 8000)),
    squawk: makeSquawk(i + 1),
    phase: 'PRE_FLIGHT',
    assignedRunway: '07',
    clearance: { hasInitialClearance: false, takeoffCleared: false, landingCleared: false, taxiClearance: null },
    position: { lat: 17.31 + i * 0.01, lon: -62.72 - i * 0.01, alt: 0, heading: 70, groundSpeed: 0, verticalSpeed: 0 },
    radio: { controller: 'Ground', frequency: '121.90', lastTransmissionAt: 0 },
    distanceToAirportNm: 20 + i * 3,
    nextActionAt: Date.now() + 2000 + i * 3500
  };
}
module.exports = { makeFlightPlan };
