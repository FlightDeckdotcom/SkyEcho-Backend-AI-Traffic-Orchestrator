const PHASES = ['PRE_FLIGHT','PUSHBACK','TAXI_OUT','HOLD_SHORT','TAKEOFF','CLIMB','ENROUTE','DESCENT','APPROACH','FINAL','LANDING','TAXI_IN','SHUTDOWN'];
function advancePhase(ac) {
  const idx = PHASES.indexOf(ac.phase);
  if (idx >= 0 && idx < PHASES.length - 1) ac.phase = PHASES[idx + 1];
  return ac.phase;
}
function updateKinematics(ac, dtSec = 1) {
  const nmPerSec = (ac.position.groundSpeed || 0) / 3600;
  const dNm = nmPerSec * dtSec;
  const hdg = (ac.position.heading || 0) * Math.PI / 180;
  const dLat = Math.cos(hdg) * dNm / 60;
  const dLon = Math.sin(hdg) * dNm / (60 * Math.cos((ac.position.lat || 0) * Math.PI / 180) || 1);
  ac.position.lat += dLat;
  ac.position.lon += dLon;
  ac.position.alt = Math.max(0, ac.position.alt + (ac.position.verticalSpeed || 0) * dtSec / 60);
  return ac;
}
module.exports = { PHASES, advancePhase, updateKinematics };
