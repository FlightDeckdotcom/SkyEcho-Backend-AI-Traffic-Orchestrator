function adsbPacket(ac) {
  return {
    timestamp: Math.floor(Date.now()/1000),
    icao24: ac.icao24,
    callsign: ac.callsign,
    spokenCallsign: ac.spokenCallsign,
    type: ac.type,
    telemetry: {
      lat: Number(ac.position.lat.toFixed(6)), lon: Number(ac.position.lon.toFixed(6)), alt: Math.round(ac.position.alt),
      gs: Math.round(ac.position.groundSpeed || 0), trk: Math.round(ac.position.heading || 0), vs: Math.round(ac.position.verticalSpeed || 0)
    },
    flight_plan: { rules: ac.rules, origin: ac.origin, dest: ac.dest, phase: ac.phase },
    squawk: ac.squawk
  };
}
module.exports = { adsbPacket };
