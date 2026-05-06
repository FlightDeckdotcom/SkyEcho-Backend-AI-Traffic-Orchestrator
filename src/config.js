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
  discordBridgeSecret: process.env.DISCORD_BRIDGE_SECRET || process.env.BRIDGE_SECRET || '',
  userCallsigns: process.env.USER_CALLSIGNS || process.env.USER_CALLSIGN || 'BWA268,N23566',
  userPriorityHoldMs: num('USER_PRIORITY_HOLD_MS', 9000),
  userPttHoldMs: num('USER_PTT_HOLD_MS', 4500),
  oneWorldMode: String(process.env.ONE_WORLD_MODE || 'true').toLowerCase() !== 'false',
  // v1.5: SkyEchoCabin main ATC owns the controller voice. Backend AI traffic controller responses are internal by default.
  trafficAtcAudio: String(process.env.TRAFFIC_ATC_AUDIO || 'false').toLowerCase() === 'true',
  aiPilotAudio: String(process.env.AI_PILOT_AUDIO || 'true').toLowerCase() !== 'false',
  dropTrafficAudioDuringUserPriority: String(process.env.DROP_TRAFFIC_AUDIO_DURING_USER_PRIORITY || 'true').toLowerCase() !== 'false',

  // v1.6 lightweight scoped session mode
  aiSessionAircraftMin: num('AI_SESSION_AIRCRAFT_MIN', 3),
  aiSessionAircraftMax: num('AI_SESSION_AIRCRAFT_MAX', 7),
  radioEventMinMs: num('RADIO_EVENT_MIN_MS', 20000),
  radioEventMaxMs: num('RADIO_EVENT_MAX_MS', 45000),
  maxRadioQueue: num('MAX_RADIO_QUEUE', 8),
  maxAudioFiles: num('MAX_AUDIO_FILES', 10),
  audioRetentionMs: num('AUDIO_RETENTION_MS', 60000),
  autoPauseNoClients: String(process.env.AUTO_PAUSE_NO_CLIENTS || 'true').toLowerCase() !== 'false',
  scopedTrafficOnly: String(process.env.SCOPED_TRAFFIC_ONLY || 'true').toLowerCase() !== 'false',
  // v1.7: AI traffic audio should not create unanswered requests.
  // It speaks readbacks/position reports only while SkyEchoCabin main ATC owns controller logic.
  aiPilotReadbackOnly: String(process.env.AI_PILOT_READBACK_ONLY || 'true').toLowerCase() !== 'false',
  allowAiPilotRequests: String(process.env.ALLOW_AI_PILOT_REQUESTS || 'false').toLowerCase() === 'true',
  frontendUserPriorityEndpoint: true
};
