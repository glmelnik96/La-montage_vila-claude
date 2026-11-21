// Full-file silence scan. audio.mjs answers "is THIS boundary clean?" one window
// at a time; this answers "where are all the pauses in 72 minutes?" in a single
// pass, which is what you need before you have any boundaries at all.
//
//   node scripts/scan.mjs --src <media> [--hop 0.02] [--thresh -40] [--min 0.6]
//                         [--json out.json]
//
// Streams the decode instead of buffering it: a 72-minute file at 48 kHz mono is
// 400 MB of PCM and execFileSync's maxBuffer will not hold it.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const SR = 48000;
const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : d;
};

// RMS per `hop`-second window over the whole file, streamed.
export function scanEnvelope(src, hop = 0.02, onWindow) {
  return new Promise((resolve, reject) => {
    const win = Math.round(SR * hop);
    const ff = spawn('ffmpeg', ['-v', 'error', '-i', src, '-vn',
      '-ac', '1', '-ar', String(SR), '-f', 's16le', '-acodec', 'pcm_s16le', 'pipe:1']);
    let carry = Buffer.alloc(0), idx = 0, err = '';
    ff.stderr.on('data', (d) => { err += d; });
    ff.stdout.on('data', (chunk) => {
      let buf = carry.length ? Buffer.concat([carry, chunk]) : chunk;
      let off = 0;
      while (off + win * 2 <= buf.length) {
        let s = 0;
        for (let k = 0; k < win; k++) { const v = buf.readInt16LE(off + k * 2) / 32768; s += v * v; }
        const rms = Math.sqrt(s / win);
        onWindow(idx * hop, rms > 0 ? 20 * Math.log10(rms) : -99);
        idx++; off += win * 2;
      }
      carry = buf.subarray(off);
    });
    ff.on('error', reject);
    ff.on('close', (code) => code === 0 ? resolve(idx * hop) : reject(new Error(err || `ffmpeg exit ${code}`)));
  });
}

// Contiguous runs below `thresh` lasting at least `min` seconds.
export async function silences(src, { hop = 0.02, thresh = -40, min = 0.6 } = {}) {
  const out = [];
  let run = null;
  const dur = await scanEnvelope(src, hop, (t, db) => {
    if (db < thresh) {
      if (!run) run = { s: t, e: t + hop, min: db };
      else { run.e = t + hop; run.min = Math.min(run.min, db); }
    } else if (run) { out.push(run); run = null; }
  });
  if (run) out.push(run);
  return {
    dur,
    silences: out.map(r => ({ s: +r.s.toFixed(3), e: +r.e.toFixed(3),
                              d: +(r.e - r.s).toFixed(3), min: +r.min.toFixed(1) }))
                .filter(r => r.d >= min)
  };
}

if (process.argv[1] && process.argv[1].endsWith('scan.mjs')) {
  const src = arg('src');
  if (!src) { console.error('usage: scan.mjs --src <media> [--hop 0.02] [--thresh -40] [--min 0.6] [--json out]'); process.exit(2); }
  const hop = +arg('hop', 0.02), thresh = +arg('thresh', -40), min = +arg('min', 0.6);
  const res = await silences(src, { hop, thresh, min });
  const json = arg('json');
  if (json) writeFileSync(json, JSON.stringify(res));
  console.error(`${res.dur.toFixed(2)}s scanned, ${res.silences.length} pauses >= ${min}s below ${thresh} dB`);
  if (!json) for (const g of res.silences)
    console.log(`${g.s.toFixed(2)} -> ${g.e.toFixed(2)}  d=${g.d.toFixed(2)}  min=${g.min}`);
}
