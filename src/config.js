require('dotenv').config();
function num(name, fallback) { const v = Number(process.env[name]); return Number.isFinite(v) ? v : fallback; }
module.exports = {
  port: num('PORT', 10000),
  bridgeSecret: process.env.BRIDGE_SECRET || 'change-me',
  tickMs: num('TRAFFIC_TICK_MS', 1000),
  adsBroadcastMs: num('ADS_BROADCAST_MS', 1000),
  defaultAirport: process.env.DEFAULT_AIRPORT || 'TKPK',
  defaultRadiusNm: num('DEFAULT_RADIUS_NM', 100),
  defaultDensity: num('DEFAULT_DENSITY', 3),
  enableAiTraffic: String(process.env.ENABLE_AI_TRAFFIC || 'true').toLowerCase() !== 'false'
};
