const { makeFlightPlan } = require('./FlightPlanFactory');

function normalizeCallsign(callsign='') {
  return String(callsign || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function spawnFromSchedules(schedules, routes, airlineRegistry, opts = {}) {
  const density = Number(opts.density || 3);
  const excluded = new Set((opts.excludeCallsigns || []).map(normalizeCallsign).filter(Boolean));
  const targetCount = Math.max(1, density * 3);
  const selected = [];
  for (const row of schedules) {
    if (!row || !row.callsign) continue;
    if (excluded.has(normalizeCallsign(row.callsign))) continue;
    selected.push(row);
    if (selected.length >= targetCount) break;
  }
  return selected.map((row, i) => makeFlightPlan(row, routes, airlineRegistry, i));
}
module.exports = { spawnFromSchedules, normalizeCallsign };
