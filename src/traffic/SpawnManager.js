const { makeFlightPlan } = require('./FlightPlanFactory');
function spawnFromSchedules(schedules, routes, airlineRegistry, opts = {}) {
  const density = Number(opts.density || 3);
  return schedules.slice(0, Math.min(schedules.length, Math.max(1, density * 4))).map((row, i) => makeFlightPlan(row, routes, airlineRegistry, i));
}
module.exports = { spawnFromSchedules };
