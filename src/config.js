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
  enableAiTraffic: String(process.env.ENABLE_AI_TRAFFIC || 'true').toLowerCase() !== 'false',
  navDataBaseUrl: process.env.NAVDATA_BASE_URL || 'https://raw.githubusercontent.com/FlightDeckdotcom/SKYECHOCABIN-Discord-Bot/main/data',
  preferRemoteNavData: String(process.env.PREFER_REMOTE_NAVDATA || 'true').toLowerCase() !== 'false',
  radioMinGapMs: num('RADIO_MIN_GAP_MS', 11000),
  aiPhaseScale: num('AI_PHASE_SCALE', 2.5),
  maxTrafficDensity: num('MAX_TRAFFIC_DENSITY', 2),
  piperEnabled: String(process.env.PIPER_ENABLED || 'false').toLowerCase() === 'true',
  piperBin: process.env.PIPER_BIN || 'python3 -m piper',
  atcTtsMode: process.env.ATC_TTS_MODE || 'piper',
  trafficTtsMode: process.env.TRAFFIC_TTS_MODE || 'piper',
  cabinTtsMode: process.env.CABIN_TTS_MODE || 'piper',
  atcPiperVoice: process.env.ATC_PIPER_VOICE || 'models/piper/atc/high/en_US-ryan-high.onnx',
  trafficPiperVoicePool: process.env.TRAFFIC_PIPER_VOICE_POOL || 'models/piper/traffic/medium/en_US-lessac-medium.onnx',
  cabinPiperVoice: process.env.CABIN_PIPER_VOICE || 'models/piper/cabin/medium/en_US-lessac-medium.onnx',
  discordBridgeUrl: process.env.DISCORD_BRIDGE_URL || '',
  discordBridgeSecret: process.env.DISCORD_BRIDGE_SECRET || process.env.BRIDGE_SECRET || ''
};
