const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

function hashString(text='') {
  let h = 0;
  for (let i = 0; i < text.length; i++) { h = ((h << 5) - h) + text.charCodeAt(i); h |= 0; }
  return Math.abs(h);
}

function cleanVoiceName(modelPath='') {
  return path.basename(String(modelPath || '').replace(/\.onnx$/,''));
}

class VoiceRouter {
  constructor({ config, broadcast, log }) {
    this.config = config;
    this.broadcast = broadcast || (()=>{});
    this.log = log || console.log;
    this.audioDir = path.join(__dirname, '..', '..', 'tmp', 'audio');
    fs.mkdirSync(this.audioDir, { recursive:true });
    this.audioRetentionMs = Number(config.audioRetentionMs || 60000);
    this.maxAudioFiles = Number(config.maxAudioFiles || 10);
  }

  selectVoice(role, meta={}) {
    if (role === 'atc') return this.config.atcPiperVoice;
    if (role === 'cabin') return this.config.cabinPiperVoice;
    if (role === 'traffic' || role === 'pilot') {
      const pool = String(this.config.trafficPiperVoicePool || '')
        .split(',').map(v => v.trim()).filter(Boolean);
      if (!pool.length) return this.config.cabinPiperVoice;
      const key = meta.callsign || meta.spokenCallsign || meta.icao24 || meta.id || 'traffic';
      return pool[hashString(key) % pool.length];
    }
    return this.config.cabinPiperVoice;
  }

  async routeRadio(ev) {
    const role = ev.role === 'atc' ? 'atc' : 'traffic';

    // v1.5 ONE-CONTROLLER RULE:
    // AI traffic is allowed to speak as pilots, but the audible controller must be the
    // main SkyEchoCabin ATC engine. Backend ATC responses for AI traffic remain
    // internal/sequencing-only unless TRAFFIC_ATC_AUDIO=true is explicitly set.
    const isAiTrafficController = role === 'atc' && ev?.meta?.controllerScope === 'ai_traffic';
    if (isAiTrafficController && !this.config.trafficAtcAudio) {
      const internal = {
        type: 'controller_internal',
        role: 'atc',
        silent: true,
        callsign: ev.callsign,
        spokenCallsign: ev.spokenCallsign,
        text: ev.text,
        reason: 'SkyEchoCabin main ATC controls audible controller channel',
        t: Date.now()
      };
      this.broadcast(internal);
      this.log(`[VOICE] suppressed backend AI-controller audio role=atc callsign=${ev.callsign || ''} text="${ev.text}"`);
      return internal;
    }

    if (role === 'traffic' && this.config.aiPilotAudio === false) {
      const silent = { type:'traffic_internal', role:'traffic', silent:true, callsign:ev.callsign, text:ev.text, t:Date.now() };
      this.broadcast(silent);
      this.log(`[VOICE] suppressed AI pilot audio callsign=${ev.callsign || ''} text="${ev.text}"`);
      return silent;
    }

    const voice = this.selectVoice(role, ev);
    const payload = {
      type: 'voice',
      role,
      ttsMode: role === 'atc' ? this.config.atcTtsMode : this.config.trafficTtsMode,
      callsign: ev.callsign,
      spokenCallsign: ev.spokenCallsign,
      text: ev.text,
      voice,
      voiceName: cleanVoiceName(voice),
      audioUrl: null,
      playable: false,
      t: Date.now()
    };

    // Always broadcast the voice request immediately, even if Piper generation is disabled/failed.
    this.broadcast(payload);

    // Optional Discord bridge text forwarding. This lets the console bridge decide how to play it.
    this.forwardToDiscordBridge(payload).catch(err => this.log(`[VOICE] discord bridge forward failed: ${err.message}`));

    if (!this.config.piperEnabled) {
      this.log(`[VOICE] role=${role} voice=${payload.voiceName} piper=disabled text="${ev.text}"`);
      return payload;
    }

    try {
      this.cleanupAudioFiles();
      const audioUrl = await this.generatePiperWav({ text: ev.text, voice });
      const done = { ...payload, audioUrl, playable:true, type:'voice_audio' };
      this.broadcast(done);
      this.forwardToDiscordBridge(done).catch(err => this.log(`[VOICE] discord audio forward failed: ${err.message}`));
      this.scheduleDelete(audioUrl);
      this.log(`[VOICE] generated role=${role} voice=${payload.voiceName} ${audioUrl}`);
      return done;
    } catch (err) {
      const fail = { ...payload, type:'voice_error', error: err.message };
      this.broadcast(fail);
      this.log(`[VOICE] Piper failed role=${role} voice=${payload.voiceName}: ${err.message}`);
      return fail;
    }
  }

  cleanupAudioFiles() {
    try {
      const now = Date.now();
      const files = fs.readdirSync(this.audioDir)
        .filter(f => f.endsWith('.wav'))
        .map(f => { const p = path.join(this.audioDir, f); const st = fs.statSync(p); return { f, p, mtime: st.mtimeMs }; })
        .sort((a,b) => b.mtime - a.mtime);
      for (const item of files) {
        const tooOld = now - item.mtime > this.audioRetentionMs;
        const overflow = files.indexOf(item) >= this.maxAudioFiles;
        if (tooOld || overflow) { try { fs.unlinkSync(item.p); } catch {} }
      }
    } catch {}
  }

  scheduleDelete(audioUrl) {
    try {
      const f = path.basename(String(audioUrl || ''));
      if (!f.endsWith('.wav')) return;
      const p = path.join(this.audioDir, f);
      setTimeout(() => { try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch {} }, this.audioRetentionMs);
    } catch {}
  }

  generatePiperWav({ text, voice }) {
    return new Promise((resolve, reject) => {
      const absVoice = path.resolve(process.cwd(), voice);
      if (!fs.existsSync(absVoice)) return reject(new Error(`Piper model missing: ${absVoice}`));
      const outName = `${Date.now()}-${crypto.randomBytes(5).toString('hex')}.wav`;
      const outPath = path.join(this.audioDir, outName);
      const parts = String(this.config.piperBin || 'python3 -m piper').split(/\s+/).filter(Boolean);
      const cmd = parts.shift();
      const args = [...parts, '--model', absVoice, '--output_file', outPath];
      const child = spawn(cmd, args, { stdio:['pipe','pipe','pipe'] });
      let stderr='';
      child.stderr.on('data', d => { stderr += String(d); });
      child.on('error', reject);
      child.on('close', code => {
        if (code !== 0) return reject(new Error(stderr.trim() || `piper exited ${code}`));
        resolve(`/audio/${outName}`);
      });
      child.stdin.write(String(text || '').replace(/\s+/g,' ').trim());
      child.stdin.end();
    });
  }

  async forwardToDiscordBridge(payload) {
    if (!this.config.discordBridgeUrl) return;
    const url = `${String(this.config.discordBridgeUrl).replace(/\/+$/,'')}/bridge/event`;
    const body = {
      type: payload.playable ? 'play_audio' : 'play_text',
      role: payload.role,
      callsign: payload.callsign,
      text: payload.text,
      voice: payload.voiceName,
      audioUrl: payload.audioUrl,
      source: 'skyecho-backend-v1.3'
    };
    await fetch(url, {
      method:'POST',
      headers:{ 'Content-Type':'application/json', 'x-bridge-secret': this.config.discordBridgeSecret || this.config.bridgeSecret || '' },
      body:JSON.stringify(body)
    });
  }
}
module.exports = { VoiceRouter };
