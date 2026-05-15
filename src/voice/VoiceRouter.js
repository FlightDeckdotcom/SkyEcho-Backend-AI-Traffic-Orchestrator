const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

function hashString(text = '') {
  let h = 0;

  for (let i = 0; i < text.length; i += 1) {
    h = ((h << 5) - h) + text.charCodeAt(i);
    h |= 0;
  }

  return Math.abs(h);
}

function cleanVoiceName(modelPath = '') {
  return path.basename(String(modelPath || '').replace(/\.onnx$/, ''));
}

function voiceFamilyFromName(name = '') {
  const clean = cleanVoiceName(name)
    .replace(/\.onnx\.json$/i, '')
    .replace(/\.json$/i, '')
    .replace(/\.onnx$/i, '');

  // Expected Piper format:
  // en_US-amy-medium
  // en_US-ryan-high
  // en_US-hfc_female-medium
  // en_US-libritts-high
  const match = clean.match(/^[a-z]{2}_[A-Z]{2}-(.+?)-(low|medium|high)$/);

  if (match) {
    return match[1].toLowerCase();
  }

  // Fallback: remove final quality tag if present.
  return clean
    .replace(/-(low|medium|high)$/i, '')
    .replace(/^en_[A-Z]{2}-/i, '')
    .toLowerCase();
}

function voiceQualityFromName(name = '') {
  const clean = cleanVoiceName(name);
  const match = clean.match(/-(low|medium|high)$/i);
  return match ? match[1].toLowerCase() : 'unknown';
}

function normalizeFrequency(freq = '') {
  return String(freq || '')
    .trim()
    .replace(/[^\d.]/g, '');
}

function uniqueByPath(items) {
  const seen = new Set();
  const out = [];

  for (const item of items) {
    if (!item || !item.path) continue;

    const key = path.resolve(item.path);

    if (seen.has(key)) continue;

    seen.add(key);
    out.push(item);
  }

  return out;
}

class VoiceRouter {
  constructor({ config, broadcast, log }) {
    this.config = config || {};
    this.broadcast = broadcast || (() => {});
    this.log = log || console.log;

    this.audioDir = path.join(__dirname, '..', '..', 'tmp', 'audio');
    fs.mkdirSync(this.audioDir, { recursive: true });

    this.audioRetentionMs = Number(this.config.audioRetentionMs || 60000);
    this.maxAudioFiles = Number(this.config.maxAudioFiles || 10);

    this.voiceDir =
      this.config.piperVoiceDir ||
      process.env.PIPER_VOICE_DIR ||
      'models/piper/all';

    this.allowAllQualities =
      this.config.piperAllowAllQualities !== false &&
      String(process.env.PIPER_ALLOW_ALL_QUALITIES || 'true').toLowerCase() !== 'false';

    this.preventSameFamily =
      this.config.piperPreventSameFamily !== false &&
      String(process.env.PIPER_PREVENT_SAME_FAMILY || 'true').toLowerCase() !== 'false';

    this.voiceCache = null;
    this.voiceCacheAt = 0;
    this.voiceCacheTtlMs = Number(this.config.piperVoiceCacheTtlMs || 30000);

    // Locks keep the same controller voice stable and prevent AI traffic from
    // using the same voice family at the same time.
    this.controllerVoiceByKey = new Map();
    this.aiVoiceByCallsign = new Map();
    this.activeControllerFamilyByFrequency = new Map();
  }

  resolveModelPath(modelPath = '') {
    const raw = String(modelPath || '').trim();

    if (!raw) return '';

    if (path.isAbsolute(raw)) {
      return raw;
    }

    return path.resolve(process.cwd(), raw);
  }

  scanPiperVoices() {
    const now = Date.now();

    if (
      this.voiceCache &&
      now - this.voiceCacheAt < this.voiceCacheTtlMs
    ) {
      return this.voiceCache;
    }

    const candidates = [];

    const addVoice = (modelPath) => {
      if (!modelPath || !modelPath.endsWith('.onnx')) return;

      const abs = this.resolveModelPath(modelPath);
      const json = `${abs}.json`;

      if (!fs.existsSync(abs)) return;

      // Piper needs the .onnx.json metadata beside the model.
      if (!fs.existsSync(json)) {
        this.log(`[VOICE] skipped Piper voice missing json: ${abs}`);
        return;
      }

      const name = cleanVoiceName(abs);
      const quality = voiceQualityFromName(name);

      if (
        !this.allowAllQualities &&
        quality !== 'medium' &&
        quality !== 'high'
      ) {
        return;
      }

      candidates.push({
        path: path.relative(process.cwd(), abs),
        absPath: abs,
        json,
        name,
        family: voiceFamilyFromName(name),
        quality
      });
    };

    const walk = (dir) => {
      const absDir = this.resolveModelPath(dir);

      if (!fs.existsSync(absDir)) return;

      const entries = fs.readdirSync(absDir, { withFileTypes: true });

      for (const entry of entries) {
        const p = path.join(absDir, entry.name);

        if (entry.isDirectory()) {
          walk(p);
        } else if (entry.isFile() && entry.name.endsWith('.onnx')) {
          addVoice(p);
        }
      }
    };

    // Preferred shared voice folder.
    walk(this.voiceDir);

    // Backward-compatible explicit voices/pools from config.
    [
      this.config.atcPiperVoice,
      this.config.cabinPiperVoice,
      ...(String(this.config.trafficPiperVoicePool || '')
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean))
    ].forEach(addVoice);

    const voices = uniqueByPath(candidates).sort((a, b) => {
      const aq = this.qualityRank(a.quality);
      const bq = this.qualityRank(b.quality);

      if (aq !== bq) return bq - aq;

      return a.name.localeCompare(b.name);
    });

    this.voiceCache = voices;
    this.voiceCacheAt = now;

    if (!voices.length) {
      this.log(
        `[VOICE] no Piper voices found. voiceDir=${this.voiceDir}`
      );
    } else {
      this.log(
        `[VOICE] Piper voices scanned: ${voices.map((v) => v.name).join(', ')}`
      );
    }

    return voices;
  }

  qualityRank(quality) {
    if (quality === 'high') return 3;
    if (quality === 'medium') return 2;
    if (quality === 'low') return 1;
    return 0;
  }

  pickVoiceFromPool({
    pool,
    key,
    blockedFamilies = [],
    preferredFamilies = []
  }) {
    const voices = Array.isArray(pool) ? pool.filter(Boolean) : [];

    if (!voices.length) {
      return null;
    }

    const blocked = new Set(
      blockedFamilies
        .filter(Boolean)
        .map((x) => String(x).toLowerCase())
    );

    const preferred = new Set(
      preferredFamilies
        .filter(Boolean)
        .map((x) => String(x).toLowerCase())
    );

    let allowed = voices.filter((voice) => {
      if (!this.preventSameFamily) return true;
      return !blocked.has(String(voice.family || '').toLowerCase());
    });

    if (!allowed.length) {
      // Emergency fallback: if the user only uploaded one family, use it rather
      // than making the whole radio system silent.
      allowed = voices;
    }

    const preferredAllowed = allowed.filter((voice) =>
      preferred.has(String(voice.family || '').toLowerCase())
    );

    const finalPool = preferredAllowed.length ? preferredAllowed : allowed;
    const index = hashString(String(key || 'voice')) % finalPool.length;

    return finalPool[index];
  }

  controllerKey(meta = {}) {
    const controller =
      meta.controller ||
      meta.controllerName ||
      meta.facility ||
      meta.station ||
      meta.frequency ||
      meta.userFrequency ||
      meta.meta?.frequency ||
      'default-controller';

    return String(controller).toUpperCase();
  }

  frequencyKey(meta = {}) {
    return (
      normalizeFrequency(meta.frequency) ||
      normalizeFrequency(meta.userFrequency) ||
      normalizeFrequency(meta.meta?.frequency) ||
      normalizeFrequency(meta.controllerFrequency) ||
      'default'
    );
  }

  selectVoice(role, meta = {}) {
    const voices = this.scanPiperVoices();

    if (!voices.length) {
      if (role === 'atc') return this.config.atcPiperVoice;
      if (role === 'cabin') return this.config.cabinPiperVoice;

      const pool = String(this.config.trafficPiperVoicePool || '')
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean);

      if (pool.length) {
        const key = meta.callsign || meta.spokenCallsign || meta.icao24 || meta.id || 'traffic';
        return pool[hashString(key) % pool.length];
      }

      return this.config.cabinPiperVoice || this.config.atcPiperVoice;
    }

    if (role === 'cabin') {
      const cabinVoicePath = this.config.cabinPiperVoice;
      const cabinAbs = cabinVoicePath ? this.resolveModelPath(cabinVoicePath) : '';

      const cabin = voices.find((v) => path.resolve(v.absPath) === cabinAbs);

      if (cabin) return cabin.path;

      const picked = this.pickVoiceFromPool({
        pool: voices,
        key: 'cabin'
      });

      return picked.path;
    }

    if (role === 'atc') {
      const freq = this.frequencyKey(meta);
      const key = this.controllerKey(meta);

      const existing = this.controllerVoiceByKey.get(key);

      if (existing && fs.existsSync(existing.absPath)) {
        this.activeControllerFamilyByFrequency.set(freq, existing.family);
        return existing.path;
      }

      const preferredVoicePath = this.config.atcPiperVoice;
      const preferredAbs = preferredVoicePath ? this.resolveModelPath(preferredVoicePath) : '';

      let selected = voices.find((v) => path.resolve(v.absPath) === preferredAbs);

      if (!selected) {
        selected = this.pickVoiceFromPool({
          pool: voices,
          key,
          preferredFamilies: this.controllerPreferredFamilies(meta)
        });
      }

      this.controllerVoiceByKey.set(key, selected);
      this.activeControllerFamilyByFrequency.set(freq, selected.family);

      this.log(
        `[VOICE] controller voice locked key=${key} freq=${freq} voice=${selected.name} family=${selected.family}`
      );

      return selected.path;
    }

    if (role === 'traffic' || role === 'pilot') {
      const freq = this.frequencyKey(meta);
      const callsign =
        meta.callsign ||
        meta.spokenCallsign ||
        meta.icao24 ||
        meta.id ||
        'traffic';

      const existing = this.aiVoiceByCallsign.get(String(callsign).toUpperCase());
      const activeControllerFamily = this.activeControllerFamilyByFrequency.get(freq);

      if (
        existing &&
        fs.existsSync(existing.absPath) &&
        (
          !this.preventSameFamily ||
          !activeControllerFamily ||
          existing.family !== activeControllerFamily
        )
      ) {
        return existing.path;
      }

      const blockedFamilies = [];

      if (activeControllerFamily) {
        blockedFamilies.push(activeControllerFamily);
      }

      // Also block every controller family currently active, as extra safety.
      for (const family of this.activeControllerFamilyByFrequency.values()) {
        if (family) blockedFamilies.push(family);
      }

      const selected = this.pickVoiceFromPool({
        pool: voices,
        key: callsign,
        blockedFamilies,
        preferredFamilies: this.aiPreferredFamilies(meta)
      });

      this.aiVoiceByCallsign.set(String(callsign).toUpperCase(), selected);

      this.log(
        `[VOICE] AI traffic voice locked callsign=${callsign} freq=${freq} voice=${selected.name} family=${selected.family} blocked=${blockedFamilies.join(',') || 'none'}`
      );

      return selected.path;
    }

    const fallback = this.pickVoiceFromPool({
      pool: voices,
      key: 'fallback'
    });

    return fallback.path;
  }

  controllerPreferredFamilies(meta = {}) {
    const text = [
      meta.controller,
      meta.controllerName,
      meta.facility,
      meta.station,
      meta.region,
      meta.role
    ].filter(Boolean).join(' ').toLowerCase();

    if (/tower/.test(text)) return ['ryan', 'bryce', 'carl'];
    if (/ground|clearance/.test(text)) return ['amy', 'kristin', 'ljspeech'];
    if (/departure|approach|center/.test(text)) return ['libritts', 'ryan', 'norman', 'john'];

    return [];
  }

  aiPreferredFamilies(meta = {}) {
    const callsign = String(meta.callsign || '').toUpperCase();

    if (/^N\d/.test(callsign)) {
      return ['joe', 'john', 'danny', 'kathleen'];
    }

    if (/^(DAL|AAL|JBU|UAL|SWA|BWA|BAW|VIR|FFT)/.test(callsign)) {
      return ['hfc_male', 'hfc_female', 'sam', 'arctic', 'kusal', 'norman'];
    }

    return [];
  }

  async routeRadio(ev) {
    const role = ev.role === 'atc' ? 'atc' : 'traffic';

    // v1.5 ONE-CONTROLLER RULE:
    // AI traffic is allowed to speak as pilots, but the audible controller must be the
    // main SkyEchoCabin ATC engine. Backend ATC responses for AI traffic remain
    // internal/sequencing-only unless TRAFFIC_ATC_AUDIO=true is explicitly set.
    const isAiTrafficController =
      role === 'atc' && ev?.meta?.controllerScope === 'ai_traffic';

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

      this.log(
        `[VOICE] suppressed backend AI-controller audio role=atc callsign=${ev.callsign || ''} text="${ev.text}"`
      );

      return internal;
    }

    if (role === 'traffic' && this.config.aiPilotAudio === false) {
      const silent = {
        type: 'traffic_internal',
        role: 'traffic',
        silent: true,
        callsign: ev.callsign,
        text: ev.text,
        t: Date.now()
      };

      this.broadcast(silent);

      this.log(
        `[VOICE] suppressed AI pilot audio callsign=${ev.callsign || ''} text="${ev.text}"`
      );

      return silent;
    }

    const voice = this.selectVoice(role, ev);
    const voiceName = cleanVoiceName(voice);
    const voiceFamily = voiceFamilyFromName(voiceName);
    const voiceQuality = voiceQualityFromName(voiceName);

    const payload = {
      type: 'voice',
      role,
      ttsMode: role === 'atc' ? this.config.atcTtsMode : this.config.trafficTtsMode,
      callsign: ev.callsign,
      spokenCallsign: ev.spokenCallsign,
      text: ev.text,
      voice,
      voiceName,
      voiceFamily,
      voiceQuality,
      audioUrl: null,
      playable: false,
      t: Date.now()
    };

    // Always broadcast the voice request immediately, even if Piper generation is disabled/failed.
    this.broadcast(payload);

    // Optional Discord bridge text forwarding. This lets the console bridge decide how to play it.
    this.forwardToDiscordBridge(payload).catch((err) =>
      this.log(`[VOICE] discord bridge forward failed: ${err.message}`)
    );

    if (!this.config.piperEnabled) {
      this.log(
        `[VOICE] role=${role} voice=${payload.voiceName} family=${payload.voiceFamily} piper=disabled text="${ev.text}"`
      );

      return payload;
    }

    try {
      this.cleanupAudioFiles();

      const audioUrl = await this.generatePiperWav({
        text: ev.text,
        voice
      });

      const done = {
        ...payload,
        audioUrl,
        playable: true,
        type: 'voice_audio'
      };

      this.broadcast(done);

      this.forwardToDiscordBridge(done).catch((err) =>
        this.log(`[VOICE] discord audio forward failed: ${err.message}`)
      );

      this.scheduleDelete(audioUrl);

      this.log(
        `[VOICE] generated role=${role} voice=${payload.voiceName} family=${payload.voiceFamily} quality=${payload.voiceQuality} ${audioUrl}`
      );

      return done;
    } catch (err) {
      const fail = {
        ...payload,
        type: 'voice_error',
        error: err.message
      };

      this.broadcast(fail);

      this.log(
        `[VOICE] Piper failed role=${role} voice=${payload.voiceName}: ${err.message}`
      );

      return fail;
    }
  }

  cleanupAudioFiles() {
    try {
      const now = Date.now();

      const files = fs.readdirSync(this.audioDir)
        .filter((f) => f.endsWith('.wav'))
        .map((f) => {
          const p = path.join(this.audioDir, f);
          const st = fs.statSync(p);

          return {
            f,
            p,
            mtime: st.mtimeMs
          };
        })
        .sort((a, b) => b.mtime - a.mtime);

      for (const item of files) {
        const tooOld = now - item.mtime > this.audioRetentionMs;
        const overflow = files.indexOf(item) >= this.maxAudioFiles;

        if (tooOld || overflow) {
          try {
            fs.unlinkSync(item.p);
          } catch {}
        }
      }
    } catch {}
  }

  scheduleDelete(audioUrl) {
    try {
      const f = path.basename(String(audioUrl || ''));

      if (!f.endsWith('.wav')) return;

      const p = path.join(this.audioDir, f);

      setTimeout(() => {
        try {
          if (fs.existsSync(p)) fs.unlinkSync(p);
        } catch {}
      }, this.audioRetentionMs);
    } catch {}
  }

  generatePiperWav({ text, voice }) {
    return new Promise((resolve, reject) => {
      const absVoice = this.resolveModelPath(voice);

      if (!fs.existsSync(absVoice)) {
        return reject(new Error(`Piper model missing: ${absVoice}`));
      }

      const voiceJson = `${absVoice}.json`;

      if (!fs.existsSync(voiceJson)) {
        return reject(new Error(`Piper model json missing: ${voiceJson}`));
      }

      const outName = `${Date.now()}-${crypto.randomBytes(5).toString('hex')}.wav`;
      const outPath = path.join(this.audioDir, outName);

      const parts = String(this.config.piperBin || 'python3 -m piper')
        .split(/\s+/)
        .filter(Boolean);

      const cmd = parts.shift();

      const args = [
        ...parts,
        '--model',
        absVoice,
        '--output_file',
        outPath
      ];

      const child = spawn(cmd, args, {
        stdio: ['pipe', 'pipe', 'pipe']
      });

      let stderr = '';

      child.stderr.on('data', (d) => {
        stderr += String(d);
      });

      child.on('error', reject);

      child.on('close', (code) => {
        if (code !== 0) {
          return reject(
            new Error(stderr.trim() || `piper exited ${code}`)
          );
        }

        resolve(`/audio/${outName}`);
      });

      child.stdin.write(
        String(text || '').replace(/\s+/g, ' ').trim()
      );

      child.stdin.end();
    });
  }

  async forwardToDiscordBridge(payload) {
    if (!this.config.discordBridgeUrl) return;

    const url = `${String(this.config.discordBridgeUrl).replace(/\/+$/, '')}/bridge/event`;

    const body = {
      type: payload.playable ? 'play_audio' : 'play_text',
      role: payload.role,
      callsign: payload.callsign,
      text: payload.text,
      voice: payload.voiceName,
      voiceFamily: payload.voiceFamily,
      voiceQuality: payload.voiceQuality,
      audioUrl: payload.audioUrl,
      source: 'skyecho-backend-v1.3'
    };

    await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-bridge-secret':
          this.config.discordBridgeSecret ||
          this.config.bridgeSecret ||
          ''
      },
      body: JSON.stringify(body)
    });
  }
}

module.exports = {
  VoiceRouter
};
