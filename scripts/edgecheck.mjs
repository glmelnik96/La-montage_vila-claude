// Did any blade land inside a word?
//
//   node scripts/edgecheck.mjs --plan gen-out/slides/m8_plan.snapped.json [--thresh -45]
//
// blockcut reports drift in seconds, which only proves the ripple delete removed
// what it was told to. It says nothing about whether the boundary it was told to
// use sits in a pause. This measures that, on the waveform, for every DISTINCT
// boundary in a plan -- adjacent blocks share one, so each is checked once.
//
// For a boundary t it reports how far the nearest speech is on each side. A
// boundary with silence for 300 ms either way is safe; one with 0 ms on the right
// means the sequence opens on a syllable already in progress, and one with 0 ms on
// the left means the previous sequence ends mid-word. Those are the only two
// failures that matter -- a boundary sitting in a long pause is never wrong here,
// only possibly wrong semantically, which is what planverify.py is for.
import { readFileSync } from 'node:fs';
import { envelope } from './audio.mjs';

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : d;
};

const plan = JSON.parse(readFileSync(arg('plan'), 'utf8'));
const thresh = Number(arg('thresh', -45));
const span = Number(arg('span', 2.0));
const hop = 0.02;

// Every boundary a blade actually lands on: the ends of the kept intervals, and
// the edges of the dropped head and tail.
const times = new Map(); // t -> [labels]
const add = (t, label) => {
  const k = t.toFixed(3);
  if (!times.has(k)) times.set(k, []);
  times.get(k).push(label);
};
for (const b of plan.blocks) {
  for (const [s, e] of b.keep) { add(s, `${b.n}in`); add(e, `${b.n}out`); }
}

const pinned = new Set((plan.pinned || []).map((t) => Number(t).toFixed(3)));

// Distance from t to the nearest SPEECH, looking each way. `null` means no speech
// at all within the span -- a very long pause.
//
// Speech is `RUN` consecutive windows above `thresh`, not one. These recordings
// carry isolated 20 ms transients -- a mouse click, a chair -- that sit 60 dB above
// the room tone around them. Treating a single loud window as speech reported a
// blade "cutting speech" in the dead centre of a 1.3 s pause.
const RUN = 4; // 80 ms at hop 0.02

function speechRun(env, i, dir) {
  for (let k = 0; k < RUN; k++) {
    const e = env[i + k * dir];
    if (!e || e.db < thresh) return false;
  }
  return true;
}

function gaps(env, t) {
  let before = null, after = null;
  for (let i = env.length - 1; i >= 0; i--) {
    if (env[i].t + hop <= t && speechRun(env, i, -1)) { before = t - (env[i].t + hop); break; }
  }
  for (let i = 0; i < env.length; i++) {
    if (env[i].t >= t && speechRun(env, i, +1)) { after = env[i].t - t; break; }
  }
  return { before, after };
}

const rows = [];
for (const [k, labels] of [...times].sort((a, b) => Number(a[0]) - Number(b[0]))) {
  const t = Number(k);
  if (t <= 0.01) continue; // start of the source, nothing to cut into
  const env = envelope(plan.src, t, span, hop);
  const at = env.find((e) => e.t <= t && e.t + hop > t);
  const g = gaps(env, t);
  rows.push({ t, labels: labels.join(','), db: at ? at.db : null, ...g, pinned: pinned.has(k) });
}

const fmt = (v) => (v === null ? '  >2s' : `${(v * 1000).toFixed(0).padStart(4)}ms`);
let bad = 0, tight = 0;
for (const r of rows) {
  // Only the side that survives into a sequence can be damaged. At the very last
  // boundary of a module the speech that starts 0 ms later is the Q&A being
  // dropped -- flagging that would be flagging the edit for working.
  const keepsBefore = /out/.test(r.labels);
  const keepsAfter = /in/.test(r.labels);
  const cand = [];
  if (keepsBefore) cand.push(r.before === null ? 99 : r.before);
  if (keepsAfter) cand.push(r.after === null ? 99 : r.after);
  const worst = Math.min(...cand);
  const flag = worst < 0.06 ? 'CUTS SPEECH' : worst < 0.15 ? 'tight' : '';
  if (flag === 'CUTS SPEECH') bad++; else if (flag) tight++;
  if (flag || process.argv.includes('--all')) {
    console.log(
      `${String(r.t.toFixed(2)).padStart(9)}  ${r.labels.padEnd(12)} ${String(r.db).padStart(6)}dB` +
      `  before ${fmt(r.before)}  after ${fmt(r.after)}${r.pinned ? '  [pinned]' : ''}  ${flag}`
    );
  }
}
console.log(`module ${plan.module}: ${rows.length} boundaries, ${bad} cutting speech, ${tight} tight (<150ms)`);
