// Move every boundary in a block plan onto a real pause in the source audio.
//
//   node scripts/snapplan.mjs --plan gen-out/slides/m5_plan.json \
//       [--out gen-out/slides/m5_plan.snapped.json] [--span 6] [--min-pause 0.3] [--thresh -40]
//
// --thresh: the pause level, taken from the recording's level histogram (-40 marks quiet
// syllables as pauses on some material). The file end is the plan's sequenceEndSec.
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
const thresh = +arg('thresh', -40);

const plan = JSON.parse(readFileSync(planPath, 'utf8'));
const groups = [...(plan.blocks || []), ...(plan.dropped || [])];

// Collect every distinct boundary except the file edges, which cannot be moved.
const edges = new Set([0]);
let maxT = 0;
for (const g of groups) for (const [a, b] of g.keep) maxT = Math.max(maxT, a, b);
if (typeof plan.sequenceEndSec === 'number') edges.add(plan.sequenceEndSec);
else { edges.add(maxT); console.log(`no sequenceEndSec in the plan: ${maxT} is taken as the file end and not snapped`); }

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
  const s = snap(plan.src, t, span, thresh, minPause);
  map.set(t, s ? s.t : t);
  console.log(s
    ? `${t.toFixed(2)} -> ${s.t.toFixed(3)}  (${s.moved >= 0 ? '+' : ''}${s.moved}s, pause ${s.pause.d.toFixed(2)}s)`
    : `${t.toFixed(2)} -> ON SPEECH, left as is`);
}

// Each edge snaps on its own, so two edges less than 2 x span apart can land on the same pause
// or cross (a short block, a short dropped stumble); blockcut would then silently keep the junk.
// Such edges go back where the plan had them, and are reported for pinning by hand.
const conflicts = new Set();
const nm = (t) => map.get(t) ?? t;
const ivs = groups.flatMap((g) => g.keep).slice().sort((x, y) => x[0] - y[0]);
for (let pass = 0; pass < 5; pass++) {
  let changed = false;
  const undo = (ts) => { for (const t of ts) if (!pinned.has(t) && nm(t) !== t) { map.set(t, t); conflicts.add(t); changed = true; } };
  for (const [a, b] of ivs) if (nm(b) - nm(a) < 0.1) undo([a, b]);
  for (let i = 1; i < ivs.length; i++) if (nm(ivs[i][0]) < nm(ivs[i - 1][1]) - 0.001) undo([ivs[i - 1][1], ivs[i][0]]);
  if (!changed) break;
}
if (conflicts.size) console.log(`CONFLICT: ${[...conflicts].sort((a, b) => a - b).map((t) => t.toFixed(2)).join(', ')} snapped onto or past a neighbour; left where the plan had them — pin them by hand`);

for (const g of groups) g.keep = g.keep.map(([a, b]) => [map.get(a) ?? a, map.get(b) ?? b]);
plan.snapped = { span, minPause, thresh, conflicts: [...conflicts], at: new Date().toISOString() };
writeFileSync(outPath, JSON.stringify(plan, null, 2), 'utf8');

const moved = [...map.entries()].filter(([a, b]) => a !== b).length;
console.log(`\n${outPath}: ${map.size} boundaries, ${moved} moved, ${map.size - moved} unmoved (on speech, pinned or in conflict)`);
if (conflicts.size) process.exitCode = 1;
