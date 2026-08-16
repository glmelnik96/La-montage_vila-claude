// Move every boundary in a block plan onto a real pause in the source audio.
//
//   node scripts/snapplan.mjs --plan gen-out/slides/m5_plan.json \
//       [--out gen-out/slides/m5_plan.snapped.json] [--span 6] [--min-pause 0.3]
//
// A plan's boundaries come from the slide track (a 0.5 s sampling grid) and from
// the transcript (drifts by seconds). Both routinely land mid-word. Adjacent
// blocks SHARE a boundary, so each distinct time is snapped once and written
// back everywhere it appears — otherwise a snapped end and an unsnapped start
// would open a gap or an overlap between two sequences.
//
// Boundaries that find no pause are reported as ON SPEECH and left alone: that
// is a real finding about the edit, and silently nudging a cut into the middle
// of a sentence is worse than leaving it where the evidence put it.
//
// A plan may carry `"pinned": [t, ...]` — boundaries chosen by hand off the
// waveform, which the snapper must copy through untouched.
import { readFileSync, writeFileSync } from 'node:fs';
import { snap } from './audio.mjs';

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : d;
};

const planPath = arg('plan');
if (!planPath) { console.error('usage: snapplan.mjs --plan <file> [--out <file>]'); process.exit(2); }
const outPath = arg('out', planPath.replace(/\.json$/, '.snapped.json'));
const span = +arg('span', 6);
const minPause = +arg('min-pause', 0.3);

const plan = JSON.parse(readFileSync(planPath, 'utf8'));
const groups = [...(plan.blocks || []), ...(plan.dropped || [])];

// Collect every distinct boundary except the file edges, which cannot be moved.
const edges = new Set([0]);
let maxT = 0;
for (const g of groups) for (const [a, b] of g.keep) maxT = Math.max(maxT, a, b);
edges.add(maxT);

const times = new Set();
for (const g of groups) for (const iv of g.keep) for (const t of iv) if (!edges.has(t)) times.add(t);

// Boundaries already placed by hand off the waveform. The snapper prefers the
// LONGEST nearby pause, which is not always the right one — at the end of a
// lecture the longest gap often sits before the closing sentence rather than
// after it. Pinning says "this number is the answer, stop looking".
const pinned = new Set(plan.pinned || []);

const map = new Map();
for (const t of [...times].sort((a, b) => a - b)) {
  if (pinned.has(t)) { map.set(t, t); console.log(`${t.toFixed(2)} -> PINNED`); continue; }
  const s = snap(plan.src, t, span, -40, minPause);
  map.set(t, s ? s.t : t);
  console.log(s
    ? `${t.toFixed(2)} -> ${s.t.toFixed(3)}  (${s.moved >= 0 ? '+' : ''}${s.moved}s, pause ${s.pause.d.toFixed(2)}s)`
    : `${t.toFixed(2)} -> ON SPEECH, left as is`);
}

for (const g of groups) g.keep = g.keep.map(([a, b]) => [map.get(a) ?? a, map.get(b) ?? b]);
plan.snapped = { span, minPause, at: new Date().toISOString() };
writeFileSync(outPath, JSON.stringify(plan, null, 2), 'utf8');

const moved = [...map.entries()].filter(([a, b]) => a !== b).length;
console.log(`\n${outPath}: ${map.size} boundaries, ${moved} moved, ${map.size - moved} on speech`);
