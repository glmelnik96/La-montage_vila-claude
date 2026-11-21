// What the speaker is actually saying on either side of every blade.
//
//   node scripts/edgetext.mjs --plan gen-out/slides/m6_plan.snapped.json \
//       --tr gen-out/slides/tr6.json [--pad 10]
//
// edgecheck.mjs proves the blade sits in silence. That is necessary and not
// sufficient: a boundary can land in a clean 100 ms gap and still be in the middle
// of a thought, leaving one sequence ending on "но прежде чем" and the next opening
// on "перейти к синтаксису". This prints the tail of what the previous sequence
// keeps and the head of what the next one opens with, so both can be read.
//
// The output is meant to be READ, not parsed. Whisper's own timings drift by up to
// a second and its segments overlap, so a segment is included whenever it touches
// the window at all -- the point is the wording, not the timing.
import { readFileSync } from 'node:fs';

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : d;
};

const plan = JSON.parse(readFileSync(arg('plan'), 'utf8'));
const tr = JSON.parse(readFileSync(arg('tr'), 'utf8'));
const pad = Number(arg('pad', 10));

// segments are [start, end, ?, ?, text]
const segs = tr.segments.map((s) => ({ a: s[0], b: s[1], t: String(s[s.length - 1]).trim() }));

const say = (from, to) =>
  segs.filter((s) => s.b > from && s.a < to).map((s) => s.t).join(' ').replace(/\s+/g, ' ').trim();

const clip = (s, n, tail) => (s.length <= n ? s : tail ? '…' + s.slice(-n) : s.slice(0, n) + '…');

for (const b of plan.blocks) {
  const s = b.keep[0][0], e = b.keep[b.keep.length - 1][1];
  console.log(`\n[${b.n}] ${b.title}   p${b.pages.join(',')}   ${s}–${e}`);
  console.log(`  ← ${clip(say(s - pad, s), 220, true)}`);
  console.log(`  ▶ ${clip(say(s, s + pad), 220, false)}`);
  console.log(`  … ${clip(say(e - pad, e), 160, true)}`);
}
