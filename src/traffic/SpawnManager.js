const { makeFlightPlan } = require('./FlightPlanFactory');

function normalizeCallsign(callsign='') {
  return String(callsign || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function spawnFromSchedules(schedules, routes, airlineRegistry, opts = {}) {
  const density = Number(opts.density || 3);
  const minAircraft = Math.max(1, Number(opts.minAircraft || 3));
  const maxAircraft = Math.max(minAircraft, Number(opts.maxAircraft || 7));
  const excluded = new Set((opts.excludeCallsigns || []).map(normalizeCallsign).filter(Boolean));
  const scopeAirports = new Set((opts.scopeAirports || []).map(a => String(a || '').toUpperCase()).filter(Boolean));
  const targetCount = Math.max(minAircraft, Math.min(maxAircraft, Number(opts.targetCount || density || maxAircraft)));

  function inScope(row) {
    if (!scopeAirports.size) return true;
    const o = String(row.origin || '').toUpperCase();
    const d = String(row.dest || '').toUpperCase();
    return scopeAirports.has(o) || scopeAirports.has(d);
  }

  const selected = [];
  for (const row of schedules) {
    if (!row || !row.callsign) continue;
    if (excluded.has(normalizeCallsign(row.callsign))) continue;
    if (!inScope(row)) continue;
    selected.push(row);
    if (selected.length >= targetCount) break;
  }

  // If the user's route is too narrow for the sample schedule set, fall back to
  // non-user callsigns, but still cap hard at maxAircraft. This avoids an empty
  // radio world while preventing full-world traffic.
  if (selected.length < minAircraft) {
    for (const row of schedules) {
      if (!row || !row.callsign) continue;
      if (excluded.has(normalizeCallsign(row.callsign))) continue;
      if (selected.includes(row)) continue;
      selected.push(row);
      if (selected.length >= targetCount) break;
    }
  }
  return selected.slice(0, maxAircraft).map((row, i) => makeFlightPlan(row, routes, airlineRegistry, i));
}
module.exports = { spawnFromSchedules, normalizeCallsign };
