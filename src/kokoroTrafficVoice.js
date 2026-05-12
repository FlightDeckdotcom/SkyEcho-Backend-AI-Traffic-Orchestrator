const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const AUDIO_DIR = path.join(__dirname, '..', 'tmp', 'audio');

// Kokoro can be slow on Render cold start.
// Do not keep this at 22000ms.
const DEFAULT_KOKORO_TIMEOUT_MS = Number(process.env.KOKORO_TIMEOUT_MS || 90000);

function ensureAudioDir() {
  fs.mkdirSync(AUDIO_DIR, { recursive: true });
}

function safeName(value) {
  return (
    String(value || 'traffic')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'traffic'
  );
}

function runProcess(command, args, options = {}) {
  const timeoutMs = Number(options.timeoutMs || DEFAULT_KOKORO_TIMEOUT_MS);

  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let finished = false;

    const child = spawn(command, args, {
      cwd: path.join(__dirname, '..'),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;

      try {
        child.kill('SIGKILL');
      } catch (_) {}

      reject(new Error(`${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('error', (err) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);

      if (code !== 0) {
        return reject(
          new Error(`${command} exited ${code}: ${stderr || stdout || 'no output'}`)
        );
      }

      resolve({
        stdout: stdout.trim(),
        stderr: stderr.trim()
      });
    });
  });
}

async function runPythonScript(script, timeoutMs) {
  try {
    return await runProcess('python3', ['-c', script], { timeoutMs });
  } catch (err) {
    // Fallback for environments where python3 is not the command name.
    if (/ENOENT/i.test(String(err && err.message ? err.message : err))) {
      return await runProcess('python', ['-c', script], { timeoutMs });
    }

    throw err;
  }
}

async function runKokoro({ text, callsign, voice, speed, timeoutMs } = {}) {
  ensureAudioDir();

  const cleanText = String(text || '').trim();

  if (!cleanText) {
    throw new Error('Kokoro text is empty');
  }

  const selectedVoice = String(
    voice || process.env.KOKORO_TRAFFIC_VOICE || 'af_heart'
  );

  const selectedSpeed = Number(
    speed || process.env.KOKORO_TRAFFIC_SPEED || 1.0
  );

  const effectiveTimeoutMs = Number(timeoutMs || DEFAULT_KOKORO_TIMEOUT_MS);

  const id = `${Date.now()}-${crypto.randomBytes(5).toString('hex')}`;
  const filename = `${id}-${safeName(callsign)}.wav`;
  const outputPath = path.join(AUDIO_DIR, filename);

  const script = `
import sys
from pathlib import Path

text = ${JSON.stringify(cleanText)}
voice = ${JSON.stringify(selectedVoice)}
speed = ${JSON.stringify(selectedSpeed)}
output_path = Path(${JSON.stringify(outputPath)})

try:
    import soundfile as sf
    import numpy as np
    from kokoro import KPipeline
except Exception as e:
    print(f"KOKORO_IMPORT_ERROR: {e}", file=sys.stderr)
    sys.exit(11)

try:
    output_path.parent.mkdir(parents=True, exist_ok=True)

    pipeline = KPipeline(lang_code='a')
    generator = pipeline(text, voice=voice, speed=float(speed))

    audio_chunks = []
    sample_rate = 24000

    for item in generator:
        audio = None

        if isinstance(item, tuple):
            audio = item[-1]
        else:
            audio = getattr(item, "audio", None)

        if audio is not None:
            audio_chunks.append(audio)

    if not audio_chunks:
        print("KOKORO_NO_AUDIO", file=sys.stderr)
        sys.exit(12)

    final_audio = np.concatenate(audio_chunks)
    sf.write(str(output_path), final_audio, sample_rate)

    print(str(output_path))
except Exception as e:
    print(f"KOKORO_SYNTH_ERROR: {e}", file=sys.stderr)
    sys.exit(13)
`;

  const startedAt = Date.now();

  const result = await runPythonScript(script, effectiveTimeoutMs);

  const elapsedMs = Date.now() - startedAt;

  if (!fs.existsSync(outputPath)) {
    throw new Error(`Kokoro did not create audio file: ${outputPath}`);
  }

  const stat = fs.statSync(outputPath);

  if (!stat.size || stat.size < 1000) {
    throw new Error(`Kokoro created an invalid/empty audio file: ${outputPath}`);
  }

  return {
    ok: true,
    engine: 'kokoro',
    role: 'traffic',
    voice: selectedVoice,
    speed: selectedSpeed,
    elapsedMs,
    audioPath: outputPath,
    audioUrl: `/audio/${filename}`,
    stdout: result.stdout || '',
    stderr: result.stderr || ''
  };
}

module.exports = {
  runKokoro
};
