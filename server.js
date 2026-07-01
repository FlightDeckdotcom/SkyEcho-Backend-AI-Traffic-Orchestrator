import "dotenv/config";
import fs from "fs";
import path from "path";
import http from "http";
import { fileURLToPath } from "url";
import express from "express";
import { parse } from "csv-parse/sync";
import { WebSocketServer } from "ws";
import { Client, GatewayIntentBits, Partials, Events } from "discord.js";
import { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, EndBehaviorType, getVoiceConnection, entersState, VoiceConnectionStatus } from "@discordjs/voice";
import prism from "prism-media";
import { Readable } from "stream";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = Number(process.env.PORT || 8080);
const HOST = "0.0.0.0";
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, "data"));
const PUBLIC_DIR = path.join(__dirname, "public");

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(PUBLIC_DIR, { etag: true, maxAge: process.env.NODE_ENV === "production" ? "10m" : 0 }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

const state = {
  startedAt: new Date().toISOString(),
  clients: new Set(),
  discord: { ready: false, userTag: null, guildId: process.env.DISCORD_GUILD_ID || "", voiceChannelId: process.env.DISCORD_VOICE_CHANNEL_ID || "", connectedVoiceChannelId: "", connectedGuildId: "", lastJoinError: "", lastPilotUserId: "", receiving: false },
  aviation: { airports: new Map(), frequenciesByAirport: new Map(), runwaysByAirport: new Map(), loadedFiles: [] }
};

function log(...args) { console.log(new Date().toISOString(), ...args); }
function loadCsvIfExists(filename) {
  const full = path.join(DATA_DIR, filename);
  if (!fs.existsSync(full)) return [];
  const rows = parse(fs.readFileSync(full, "utf8"), { columns: true, skip_empty_lines: true, bom: true, relax_column_count: true, trim: true });
  state.aviation.loadedFiles.push(filename);
  return rows;
}
function getField(row, names) { for (const n of names) if (row[n] != null && String(row[n]).trim() !== "") return String(row[n]).trim(); return ""; }
function loadAviationData() {
  const airports = loadCsvIfExists("airports.csv");
  const freqs = [...loadCsvIfExists("airport-frequencies.csv"), ...loadCsvIfExists("airport_frequencies.csv")];
  const runways = loadCsvIfExists("runways.csv");
  const airportIdToIcao = new Map();
  for (const row of airports) {
    const id = getField(row, ["id", "airport_ref", "ident"]);
    const ident = getField(row, ["ident", "gps_code", "local_code", "icao_code"]).toUpperCase();
    if (!ident) continue;
    airportIdToIcao.set(id, ident);
    state.aviation.airports.set(ident, { ident, id, type: getField(row, ["type"]), name: getField(row, ["name"]), municipality: getField(row, ["municipality"]), region: getField(row, ["iso_region", "region"]), country: getField(row, ["iso_country", "country"]), latitude: Number(getField(row, ["latitude_deg", "lat"])) || null, longitude: Number(getField(row, ["longitude_deg", "lon", "lng"])) || null });
  }
  for (const row of freqs) {
    const airportIdent = getField(row, ["airport_ident", "ident", "gps_code"]).toUpperCase() || airportIdToIcao.get(getField(row, ["airport_ref"])) || "";
    if (!airportIdent) continue;
    if (!state.aviation.frequenciesByAirport.has(airportIdent)) state.aviation.frequenciesByAirport.set(airportIdent, []);
    state.aviation.frequenciesByAirport.get(airportIdent).push({ type: getField(row, ["type"]).toUpperCase(), description: getField(row, ["description"]), frequencyMhz: Number(getField(row, ["frequency_mhz", "frequency", "freq"])) || null });
  }
  for (const row of runways) {
    const airportIdent = getField(row, ["airport_ident", "ident"]).toUpperCase() || airportIdToIcao.get(getField(row, ["airport_ref"])) || "";
    if (!airportIdent) continue;
    if (!state.aviation.runwaysByAirport.has(airportIdent)) state.aviation.runwaysByAirport.set(airportIdent, []);
    state.aviation.runwaysByAirport.get(airportIdent).push({ leIdent: getField(row, ["le_ident"]), heIdent: getField(row, ["he_ident"]), lengthFt: Number(getField(row, ["length_ft"])) || null, widthFt: Number(getField(row, ["width_ft"])) || null, surface: getField(row, ["surface"]) });
  }
  applyPiarcoPriorityOverrides();
}
function applyPiarcoPriorityOverrides() {
  const priority = {
    TKPK: { name: "Robert L. Bradshaw International", frequencies: [{ type: "GND", description: "Bradshaw Ground", frequencyMhz: 121.9 }, { type: "TWR", description: "Bradshaw Tower", frequencyMhz: 118.3 }, { type: "APP", description: "Bradshaw Approach/Departure", frequencyMhz: 119.6 }, { type: "CTR", description: "San Juan / Piarco Coordination", frequencyMhz: 128.3 }], runways: [{ leIdent: "07", heIdent: "25", lengthFt: null, widthFt: null, surface: "ASP" }] },
    TKPN: { name: "Vance W. Amory International", frequencies: [{ type: "GND", description: "Amory Ground", frequencyMhz: 121.6 }, { type: "TWR", description: "Amory Tower", frequencyMhz: 120.5 }, { type: "APP", description: "Bradshaw Approach/Departure", frequencyMhz: 119.6 }], runways: [{ leIdent: "10", heIdent: "28", lengthFt: null, widthFt: null, surface: "ASP" }] },
    TAPA: { name: "V.C. Bird International", frequencies: [{ type: "GND", description: "Bird Ground", frequencyMhz: 121.9 }, { type: "TWR", description: "Bird Tower", frequencyMhz: 118.2 }, { type: "APP", description: "Bird Approach/Departure", frequencyMhz: 119.1 }] },
    TJSJ: { name: "Luis Muñoz Marín International", frequencies: [{ type: "GND", description: "San Juan Ground", frequencyMhz: 121.9 }, { type: "TWR", description: "San Juan Tower", frequencyMhz: 118.2 }, { type: "DEP", description: "San Juan Departure", frequencyMhz: 119.6 }, { type: "APP", description: "San Juan Approach", frequencyMhz: 119.1 }, { type: "CTR", description: "San Juan Center", frequencyMhz: 128.3 }] }
  };
  for (const [icao, cfg] of Object.entries(priority)) {
    if (!state.aviation.airports.has(icao)) state.aviation.airports.set(icao, { ident: icao, name: cfg.name, source: "piarco-priority" });
    if (cfg.frequencies) state.aviation.frequenciesByAirport.set(icao, cfg.frequencies);
    if (cfg.runways && !state.aviation.runwaysByAirport.has(icao)) state.aviation.runwaysByAirport.set(icao, cfg.runways);
  }
}
loadAviationData();

app.get("/api/health", (req, res) => res.json({ ok: true, service: "SkyEcho Hybrid Discord Tunnel", startedAt: state.startedAt, publicUrl: process.env.PUBLIC_URL || "", websocketPath: "/ws", discord: state.discord, data: { loadedFiles: state.aviation.loadedFiles, airportCount: state.aviation.airports.size, frequencyAirportCount: state.aviation.frequenciesByAirport.size, runwayAirportCount: state.aviation.runwaysByAirport.size } }));
app.get("/api/airport/:icao", (req, res) => { const icao = String(req.params.icao || "").toUpperCase(); const airport = state.aviation.airports.get(icao); if (!airport) return res.status(404).json({ ok: false, error: "AIRPORT_NOT_FOUND", icao }); res.json({ ok: true, airport, frequencies: state.aviation.frequenciesByAirport.get(icao) || [], runways: state.aviation.runwaysByAirport.get(icao) || [] }); });
app.get("/api/airports/search", (req, res) => { const q = String(req.query.q || "").toUpperCase().trim(); const out = []; for (const [ident, airport] of state.aviation.airports) { if (!q || ident.includes(q) || String(airport.name || "").toUpperCase().includes(q)) out.push({ ident, name: airport.name, region: airport.region, country: airport.country, frequencies: state.aviation.frequenciesByAirport.get(ident) || [], runways: state.aviation.runwaysByAirport.get(ident) || [] }); if (out.length >= 50) break; } res.json({ ok: true, results: out }); });

function broadcast(obj) { const text = JSON.stringify(obj); for (const ws of state.clients) if (ws.readyState === ws.OPEN) ws.send(text); }
wss.on("connection", ws => { state.clients.add(ws); ws.send(JSON.stringify({ type: "SERVER_HELLO", service: "SkyEcho Hybrid Discord Tunnel", discord: state.discord, at: Date.now() })); ws.on("message", async raw => { let msg; try { msg = JSON.parse(String(raw)); } catch { ws.send(JSON.stringify({ type: "ERROR", message: "Invalid JSON packet." })); return; } try { if (msg.type === "CLIENT_HELLO") ws.send(JSON.stringify({ type: "DISCORD_STATUS", connected: Boolean(state.discord.connectedVoiceChannelId), message: state.discord.connectedVoiceChannelId ? "Discord voice connected." : "Discord tunnel ready; bot not in voice yet." })); if (msg.type === "DISCORD_JOIN_REQUEST") ws.send(JSON.stringify(await joinConfiguredVoiceChannel())); if (msg.type === "ATC_SPEECH_TRIGGER") { const text = String(msg.text || "").trim(); if (!text) { ws.send(JSON.stringify({ type: "ERROR", message: "ATC speech text was empty." })); return; } const result = await sendSpeechToDiscord(text); ws.send(JSON.stringify({ type: "ATC_SPEECH_ACK", ok: result.ok, message: result.message || "" })); } } catch (error) { ws.send(JSON.stringify({ type: "ERROR", message: error.message || String(error) })); } }); ws.on("close", () => state.clients.delete(ws)); });

const discord = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent], partials: [Partials.Channel] });
const voiceSessions = new Map();
discord.once(Events.ClientReady, client => { state.discord.ready = true; state.discord.userTag = client.user.tag; log(`Discord bot ready as ${client.user.tag}`); });
discord.on(Events.MessageCreate, async message => { if (message.author.bot) return; const content = String(message.content || "").trim(); if (/^!skyecho\s+join\b/i.test(content)) { const channel = message.member?.voice?.channel; if (!channel) { await message.reply("Join a Discord voice channel first, then run `!skyecho join`."); return; } const result = await joinVoice(channel); await message.reply(result.ok ? `SkyEcho joined **${channel.name}**.` : `SkyEcho join failed: ${result.message}`); } if (/^!skyecho\s+leave\b/i.test(content)) { const conn = getVoiceConnection(message.guild.id); if (conn) conn.destroy(); state.discord.connectedVoiceChannelId = ""; state.discord.connectedGuildId = ""; broadcast({ type: "DISCORD_STATUS", connected: false, message: "Discord tunnel disconnected." }); await message.reply("SkyEcho disconnected from voice."); } if (/^!skyecho\s+say\s+/i.test(content)) { const text = content.replace(/^!skyecho\s+say\s+/i, "").trim(); const result = await sendSpeechToDiscord(text); await message.reply(result.ok ? "Sent ATC audio to Discord." : `TTS failed: ${result.message}`); } });
async function joinConfiguredVoiceChannel() { const channelId = process.env.DISCORD_VOICE_CHANNEL_ID || state.discord.voiceChannelId; if (!channelId) return { type: "ERROR", ok: false, message: "DISCORD_VOICE_CHANNEL_ID is not set. Use !skyecho join from Discord, or set the channel ID in .env." }; const channel = await discord.channels.fetch(channelId).catch(() => null); if (!channel) return { type: "ERROR", ok: false, message: `Voice channel not found: ${channelId}` }; return joinVoice(channel); }
async function joinVoice(channel) { try { if (!channel || !channel.guild) throw new Error("Invalid Discord voice channel."); const connection = joinVoiceChannel({ channelId: channel.id, guildId: channel.guild.id, adapterCreator: channel.guild.voiceAdapterCreator, selfDeaf: false, selfMute: false }); await entersState(connection, VoiceConnectionStatus.Ready, 20000); const player = createAudioPlayer(); connection.subscribe(player); const session = { connection, player, channelId: channel.id, guildId: channel.guild.id }; voiceSessions.set(channel.guild.id, session); state.discord.connectedVoiceChannelId = channel.id; state.discord.connectedGuildId = channel.guild.id; state.discord.lastJoinError = ""; setupReceiver(connection); broadcast({ type: "DISCORD_STATUS", connected: true, message: `Discord tunnel joined ${channel.name}.` }); return { type: "DISCORD_STATUS", ok: true, connected: true, message: `Joined ${channel.name}.` }; } catch (error) { state.discord.lastJoinError = error.message || String(error); broadcast({ type: "ERROR", message: `Discord join failed: ${state.discord.lastJoinError}` }); return { type: "ERROR", ok: false, message: state.discord.lastJoinError }; } }
function setupReceiver(connection) { const receiver = connection.receiver; if (!receiver || receiver.__skyechoHooked) return; receiver.__skyechoHooked = true; receiver.speaking.on("start", userId => { state.discord.receiving = true; state.discord.lastPilotUserId = userId; broadcast({ type: "PILOT_TRANSMITTING", userId, at: Date.now() }); const opusStream = receiver.subscribe(userId, { end: { behavior: EndBehaviorType.AfterSilence, duration: 900 } }); const decoder = new prism.opus.Decoder({ frameSize: 960, channels: 2, rate: 48000 }); const chunks = []; const pcmStream = opusStream.pipe(decoder); pcmStream.on("data", chunk => { chunks.push(chunk); broadcast({ type: "PILOT_AUDIO_CHUNK", userId, bytes: chunk.length, at: Date.now() }); }); pcmStream.on("end", () => { state.discord.receiving = false; const pcmBuffer = Buffer.concat(chunks); broadcast({ type: "PILOT_TRANSMISSION_END", userId, pcmBytes: pcmBuffer.length, at: Date.now() }); }); pcmStream.on("error", error => { state.discord.receiving = false; broadcast({ type: "PILOT_TRANSMISSION_END", userId, error: error.message, at: Date.now() }); }); }); receiver.speaking.on("end", userId => { state.discord.receiving = false; broadcast({ type: "PILOT_TRANSMISSION_END", userId, at: Date.now() }); }); }
function activeVoiceSession() { if (state.discord.connectedGuildId && voiceSessions.has(state.discord.connectedGuildId)) return voiceSessions.get(state.discord.connectedGuildId); for (const session of voiceSessions.values()) return session; return null; }
async function sendSpeechToDiscord(text) { const session = activeVoiceSession(); if (!session) return { ok: false, message: "Discord bot is not connected to a voice channel." }; try { const audioBuffer = await renderTtsAudio(text); const resource = createAudioResource(Readable.from(audioBuffer), { inputType: undefined }); session.player.play(resource); await new Promise(resolve => { const cleanup = () => { session.player.off(AudioPlayerStatus.Idle, cleanup); resolve(); }; session.player.once(AudioPlayerStatus.Idle, cleanup); setTimeout(cleanup, 30000); }); broadcast({ type: "ATC_SPEECH_PLAYED", text, at: Date.now() }); return { ok: true, message: "ATC audio sent to Discord." }; } catch (error) { return { ok: false, message: error.message || String(error) }; } }
async function renderTtsAudio(text) { if (String(process.env.TTS_PROVIDER || "stub").toLowerCase() === "http" && process.env.TTS_ENDPOINT) { const res = await fetch(process.env.TTS_ENDPOINT, { method: "POST", headers: { "Content-Type": "application/json", ...(process.env.TTS_API_KEY ? { Authorization: `Bearer ${process.env.TTS_API_KEY}` } : {}) }, body: JSON.stringify({ text, voice: "en_US-lessac-medium", role: "atc", radio: true, format: "wav" }) }); if (!res.ok) throw new Error(`TTS endpoint HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`); return Buffer.from(await res.arrayBuffer()); } return generateNoticeWav(text); }
function generateNoticeWav(text) { const sampleRate = 48000; const durationSec = Math.min(2.2, Math.max(0.7, String(text).length / 80)); const samples = Math.floor(sampleRate * durationSec); const data = Buffer.alloc(samples * 2); for (let i = 0; i < samples; i++) { const t = i / sampleRate; const carrier = Math.sin(2 * Math.PI * 740 * t); const gate = (Math.floor(t * 8) % 2) ? 0.25 : 0.65; const envelope = Math.min(1, i / 1200, (samples - i) / 1200); data.writeInt16LE(Math.floor(Math.max(-1, Math.min(1, carrier * gate * envelope)) * 32767), i * 2); } return wavHeader(data.length, sampleRate, 1, 16, data); }
function wavHeader(dataLength, sampleRate, channels, bitsPerSample, pcmData) { const blockAlign = channels * bitsPerSample / 8; const byteRate = sampleRate * blockAlign; const buffer = Buffer.alloc(44 + dataLength); buffer.write("RIFF", 0); buffer.writeUInt32LE(36 + dataLength, 4); buffer.write("WAVE", 8); buffer.write("fmt ", 12); buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(channels, 22); buffer.writeUInt32LE(sampleRate, 24); buffer.writeUInt32LE(byteRate, 28); buffer.writeUInt16LE(blockAlign, 32); buffer.writeUInt16LE(bitsPerSample, 34); buffer.write("data", 36); buffer.writeUInt32LE(dataLength, 40); pcmData.copy(buffer, 44); return buffer; }
if (process.env.DISCORD_BOT_TOKEN) discord.login(process.env.DISCORD_BOT_TOKEN).catch(error => log("Discord login failed:", error.message || error)); else log("DISCORD_BOT_TOKEN missing. Web server will run, Discord tunnel disabled.");
server.listen(PORT, HOST, () => { log(`SkyEcho Hybrid server listening on http://${HOST}:${PORT}`); log(`Static files: ${PUBLIC_DIR}`); log(`Data dir: ${DATA_DIR}`); });
