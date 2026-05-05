function buildAirlineRegistry(rows) {
  const m = new Map();
  for (const r of rows) m.set(String(r.code || '').toUpperCase(), r);
  return m;
}
module.exports = { buildAirlineRegistry };
