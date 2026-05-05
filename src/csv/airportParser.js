function buildAirportDb(rows) {
  const airports = new Map();
  for (const r of rows) {
    const icao = String(r.airport_icao || '').toUpperCase();
    if (!icao) continue;
    if (!airports.has(icao)) airports.set(icao, { icao, runways: [], taxiways: [], holdShorts: [], gates: [], ramps: [], fbos: [], raw: [] });
    const a = airports.get(icao);
    const item = { ...r, lat: Number(r.lat), lon: Number(r.lon), heading: Number(r.heading), lengthFt: Number(r.length_ft || 0) };
    a.raw.push(item);
    if (r.type === 'runway') a.runways.push(item);
    if (r.type === 'taxiway') a.taxiways.push(item);
    if (r.type === 'holdshort') a.holdShorts.push(item);
    if (r.type === 'gate') a.gates.push(item);
    if (r.type === 'ramp') a.ramps.push(item);
    if (r.type === 'fbo') a.fbos.push(item);
  }
  return airports;
}
module.exports = { buildAirportDb };
