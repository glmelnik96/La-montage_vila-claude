// Ground truth for WHERE to cut: the source waveform, not the transcript.
// Whisper segment timings drift by tenths of a second, so a cut placed on a
// transcript timecode routinely slices a word. Every boundary gets measured here.
//
//   node scripts/audio.mjs env    --src <media> --at <sec> [--span 4] [--hop 0.05]
//   node scripts/audio.mjs pauses --src <media> --at <sec> [--span 6] [--thresh -40]
//   node scripts/audio.mjs check  --src <media> --in <sec> --out <sec> [--thresh -40]
//   node scripts/audio.mjs snap   --src <media> --at <sec,sec,...> [--span 6] [--thresh -40]
import { execFileSync } from 'node:child_process';

const SR = 48000;

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : d;
};

// RMS envelope of [t0-span, t0+span]. `hop` is the window size AND the step, so
// windows tile without overlap and every sample is counted exactly once.
export function envelope(src, t0, span = 4, hop = 0.05) {
  // Align to a global grid so envelopes taken around different timestamps line up.
  const start = Math.max(0, Math.round((t0 - span) / hop) * hop);
  const buf = execFileSync('ffmpeg', [
    '-v', 'error', '-ss', String(start), '-t', String(span * 2),
    '-i', src, '-vn', '-ac', '1', '-ar', String(SR),
    '-f', 's16le', '-acodec', 'pcm_s16le', 'pipe:1'
  ], { maxBuffer: 1 << 28 });

  const n = Math.floor(buf.length / 2), win = Math.round(SR * hop), out = [];
  for (let i = 0; i + win <= n; i += win) {
    let s = 0;
    for (let k = 0; k < win; k++) { const v = buf.readInt16LE((i + k) * 2) / 32768; s += v * v; }
    const rms = Math.sqrt(s / win);
    out.push({ t: +(start + i / SR).toFixed(4), db: rms > 0 ? +(20 * Math.log10(rms)).toFixed(1) : -99 });
  }
  return out;
}

// Contiguous runs below `thresh` — the real pauses between phrases, which is
// where a blade can land without touching a syllable.
export function pauses(src, t0, span = 6, thresh = -40, hop = 0.05) {
  const env = envelope(src, t0, span, hop);
  const out = [];
  let run = null;
  for (const e of env) {
    if (e.db < thresh) {
      if (!run) run = { s: e.t, e: e.t, min: e.db };
      else { run.e = e.t; run.min = Math.min(run.min, e.db); }
    } else if (run) { out.push(close(run, hop)); run = null; }
  }
  if (run) out.push(close(run, hop));
  return out.filter(g => g.d >= hop * 2);
}
const close = (r, hop) => ({ ...r, e: +(r.e + hop).toFixed(3), d: +(r.e + hop - r.s).toFixed(3) });

// Is this boundary safe? Measured at BOTH resolutions on purpose:
// a 50 ms window starting at the cut averages 50 ms of what comes AFTER it, so a
// clean cut sitting just before a loud syllable reads as if it were loud itself.
// That produces false alarms. The 5 ms pass is the one that decides.
export function check(src, t, thresh = -40) {
  const coarse = envelope(src, t, 1.0, 0.05);
  const fine = envelope(src, t, 0.6, 0.005);
  const atCoarse = nearest(coarse, t);
  // level AT the cut = the 5 ms window centred on it, not the one starting on it
  const atFine = nearest(fine, t - 0.0025);
  const gs = runsBelow(fine, thresh);
  const inside = gs.find(g => t >= g.s && t <= g.e) || null;
  const closest = gs.length
    ? gs.slice().sort((a, b) => dist(a, t) - dist(b, t))[0]
    : null;
  return {
    t: +t.toFixed(3),
    coarseDb: atCoarse ? atCoarse.db : null,
    fineDb: atFine ? atFine.db : null,
    inPause: !!inside,
    pause: inside || closest,
    driftToPause: closest ? +(mid(closest) - t).toFixed(3) : null
  };
}
// Move a boundary onto the best nearby silence. A cut derived from a slide track
// or a transcript lands wherever the sampling grid fell, which is routinely
// mid-syllable. Among the pauses within `span` of the target, prefer the longest
// one and put the blade in its middle; a pause shorter than `minPause` is a
// breath, not a phrase boundary, so it is ignored. Returns null when the target
// sits in continuous speech — that is a fact worth seeing, not worth papering over.
export function snap(src, t, span = 6, thresh = -40, minPause = 0.3) {
  const gs = pauses(src, t, span, thresh).filter(g => g.d >= minPause);
  if (!gs.length) return null;
  const best = gs.slice().sort((a, b) => (b.d - a.d) || (dist(a, t) - dist(b, t)))[0];
  return { t: +mid(best).toFixed(3), pause: best, moved: +(mid(best) - t).toFixed(3) };
}

const nearest = (env, t) => env.reduce((b, e) => (b && Math.abs(b.t - t) <= Math.abs(e.t - t) ? b : e), null);
const mid = (g) => (g.s + g.e) / 2;
const dist = (g, t) => (t >= g.s && t <= g.e ? 0 : Math.min(Math.abs(g.s - t), Math.abs(g.e - t)));
function runsBelow(env, thresh) {
  const out = []; let run = null;
  for (const e of env) {
    if (e.db < thresh) { if (!run) run = { s: e.t, e: e.t, min: e.db }; else { run.e = e.t; run.min = Math.min(run.min, e.db); } }
    else if (run) { out.push({ ...run, d: +(run.e - run.s).toFixed(3) }); run = null; }
  }
  if (run) out.push({ ...run, d: +(run.e - run.s).toFixed(3) });
  return out.filter(g => g.d > 0);
}

if (process.argv[1] && process.argv[1].endsWith('audio.mjs')) {
  const mode = process.argv[2];
  const src = arg('src');
  if (!src || !mode) {
    console.error('usage: audio.mjs env|pauses|check --src <media> ...');
    process.exit(2);
  }
  if (mode === 'env') {
    const t = +arg('at'), span = +arg('span', 4), hop = +arg('hop', 0.05);
    for (const e of envelope(src, t, span, hop))
      console.log(`${e.t.toFixed(3)} ${String(e.db).padStart(7)} ${'#'.repeat(Math.max(0, Math.round((e.db + 70) / 2)))}`);
  } else if (mode === 'pauses') {
    const t = +arg('at'), span = +arg('span', 6), th = +arg('thresh', -40), hop = +arg('hop', 0.05);
    for (const g of pauses(src, t, span, th, hop))
      console.log(`${g.s.toFixed(3)} -> ${g.e.toFixed(3)}  d=${g.d.toFixed(3)}  min=${g.min}  ${g.s - t >= 0 ? '+' : ''}${(g.s - t).toFixed(2)}`);
  } else if (mode === 'check') {
    const th = +arg('thresh', -40);
    for (const [label, key] of [['IN', 'in'], ['OUT', 'out']]) {
      const raw = arg(key);
      if (raw === undefined) continue;
      const r = check(src, +raw, th);
      const verdict = r.inPause ? 'CLEAN' : (r.fineDb < th ? 'CLEAN' : 'ON SPEECH');
      console.log(`${label} ${r.t}  ${verdict}  fine ${r.fineDb} dB (coarse ${r.coarseDb} dB)` +
        `  pause ${r.pause ? r.pause.s.toFixed(3) + '..' + r.pause.e.toFixed(3) : 'none'}` +
        `  move ${r.driftToPause >= 0 ? '+' : ''}${r.driftToPause}s to centre it`);
    }
  } else if (mode === 'snap') {
    const span = +arg('span', 6), th = +arg('thresh', -40), minPause = +arg('min-pause', 0.3);
    for (const raw of String(arg('at', '')).split(',').filter(Boolean)) {
      const t = +raw;
      const s = snap(src, t, span, th, minPause);
      console.log(s
        ? `${t.toFixed(2)} -> ${s.t.toFixed(3)}  (${s.moved >= 0 ? '+' : ''}${s.moved}s, pause ${s.pause.d.toFixed(2)}s)`
        : `${t.toFixed(2)} -> NO PAUSE within ${span}s — boundary sits on speech`);
    }
  } else { console.error(`unknown mode ${mode}`); process.exit(2); }
}
