// Find re-recorded fragments in a long single-take recording.
//
//   node scripts/retakes.mjs --segs <segments.json> [--k 6] [--min 10]
//                            [--window 600] [--json out.json]
//
// A retake is not "the speaker used the same word twice" — a training recording
// repeats its own terminology constantly. A retake is a LONG run of tokens
// reappearing nearly verbatim a short time later, because the speaker restarted
// the sentence or the paragraph. So: seed on exact k-gram hits, extend each seed
// along its diagonal, merge the seeds into runs, and keep only the long ones.
//
// Times are interpolated inside a segment and are therefore approximate — enough
// to place a marker, never enough to place a blade. Measure the cut separately.
import { readFileSync, writeFileSync } from 'node:fs';

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : d;
};

const norm = (s) => s.toLowerCase()
  .replace(/ё/g, 'е')
  .replace(/[^a-zа-я0-9 ]/gi, ' ')
  .replace(/\s+/g, ' ').trim();

// One flat token stream, each token carrying an interpolated timestamp.
export function tokenize(segs) {
  const toks = [];
  for (const s of segs) {
    const ws = norm(s.text).split(' ').filter(Boolean);
    if (!ws.length) continue;
    const step = (s.endSec - s.startSec) / ws.length;
    ws.forEach((w, i) => toks.push({
      w, t: +(s.startSec + i * step).toFixed(2), tE: +(s.startSec + (i + 1) * step).toFixed(2)
    }));
  }
  return toks;
}

export function findRetakes(toks, { k = 6, min = 10, window = 600 } = {}) {
  const seen = new Map();
  for (let i = 0; i + k <= toks.length; i++) {
    const key = toks.slice(i, i + k).map(t => t.w).join(' ');
    if (!seen.has(key)) seen.set(key, []);
    seen.get(key).push(i);
  }

  // Seeds: pairs of positions sharing a k-gram, close enough in time to be a
  // retake rather than the same phrase recurring later in the lesson.
  const seeds = [];
  for (const pos of seen.values()) {
    if (pos.length < 2) continue;
    for (let a = 0; a < pos.length - 1; a++)
      for (let b = a + 1; b < pos.length; b++) {
        const i = pos[a], j = pos[b];
        if (j <= i) continue;
        if (toks[j].t - toks[i].t > window) break;
        seeds.push([i, j]);
      }
  }

  // Extend each seed along its diagonal (constant j-i), then merge seeds that
  // land on the same diagonal and overlap — one restarted paragraph produces
  // dozens of seeds that are all the same run.
  const byDiag = new Map();
  for (const [i, j] of seeds) {
    let s = i, e = i + k;
    while (s > 0 && toks[s - 1].w === toks[s - 1 + (j - i)].w) s--;
    while (e < toks.length && j - i + e < toks.length && toks[e].w === toks[e + (j - i)].w) e++;
    const d = j - i;
    if (!byDiag.has(d)) byDiag.set(d, []);
    byDiag.get(d).push([s, e]);
  }

  const runs = [];
  for (const [d, list] of byDiag) {
    list.sort((a, b) => a[0] - b[0]);
    let cur = null;
    for (const [s, e] of list) {
      if (cur && s <= cur[1]) cur[1] = Math.max(cur[1], e);
      else { if (cur) runs.push([cur[0], cur[1], d]); cur = [s, e]; }
    }
    if (cur) runs.push([cur[0], cur[1], d]);
  }

  // Score, drop the short ones, and drop runs swallowed by a longer run.
  let out = runs
    .filter(([s, e]) => e - s >= min)
    .map(([s, e, d]) => ({
      len: e - s,
      first: { s: toks[s].t, e: toks[e - 1].tE },
      second: { s: toks[s + d].t, e: toks[e - 1 + d].tE },
      text: toks.slice(s, e).map(t => t.w).join(' ')
    }))
    .sort((a, b) => b.len - a.len);

  const kept = [];
  for (const r of out) {
    const dup = kept.find(x =>
      r.first.s >= x.first.s - 0.5 && r.first.e <= x.first.e + 0.5 &&
      r.second.s >= x.second.s - 0.5 && r.second.e <= x.second.e + 0.5);
    if (!dup) kept.push(r);
  }
  return kept.sort((a, b) => a.first.s - b.first.s);
}

if (process.argv[1] && process.argv[1].endsWith('retakes.mjs')) {
  const segs = JSON.parse(readFileSync(arg('segs'), 'utf8'));
  const res = findRetakes(tokenize(segs), {
    k: +arg('k', 6), min: +arg('min', 10), window: +arg('window', 600)
  });
  const json = arg('json');
  if (json) writeFileSync(json, JSON.stringify(res, null, 1));
  const fmt = (t) => `${String(Math.floor(t / 60)).padStart(2, '0')}:${(t % 60).toFixed(1).padStart(4, '0')}`;
  console.error(`${res.length} repeated runs >= ${arg('min', 10)} tokens`);
  for (const r of res)
    console.log(`${fmt(r.first.s)}-${fmt(r.first.e)}  ->  ${fmt(r.second.s)}-${fmt(r.second.e)}  ${String(r.len).padStart(3)}w  ${r.text.slice(0, 70)}`);
}

// --- fuzzy pass -------------------------------------------------------------
// Exact k-grams only catch a retake that repeats the words. Most retakes reword
// as they go, so also test every reset point (a long pause) by asking: does what
// comes AFTER this pause restate something said shortly BEFORE it? Containment,
// not Jaccard — the second take is often shorter than the first.
export function fuzzyRetakes(toks, resets, { look = 30, back = 400, minSim = 0.45 } = {}) {
  const idxAt = (t) => {
    let lo = 0, hi = toks.length - 1, r = toks.length;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (toks[m].t >= t) { r = m; hi = m - 1; } else lo = m + 1; }
    return r;
  };
  const stop = new Set(('и в на что а с не то это как я мы вы вот так же для но у о же ну да их его' +
    ' по из за от до при или если то есть быть был была было бы вас нам вам он она они там где когда').split(' '));
  const bag = (a, b) => new Set(toks.slice(a, b).map(t => t.w).filter(w => w.length > 2 && !stop.has(w)));
  const out = [];
  for (const r of resets) {
    const j = idxAt(r.e);
    if (j + look > toks.length) continue;
    const B = bag(j, j + look);
    if (B.size < 8) continue;
    let best = null;
    for (let i = idxAt(r.s - back); i + look <= idxAt(r.s); i += 3) {
      const A = bag(i, i + look);
      if (A.size < 8) continue;
      let hit = 0; for (const w of B) if (A.has(w)) hit++;
      const sim = hit / B.size;
      if (!best || sim > best.sim) best = { sim, i };
    }
    if (best && best.sim >= minSim)
      out.push({
        sim: +best.sim.toFixed(2), pause: r.d,
        first: { s: toks[best.i].t, e: toks[best.i + look - 1].tE },
        second: { s: toks[j].t, e: toks[j + look - 1].tE },
        text: toks.slice(j, j + look).map(t => t.w).join(' ')
      });
  }
  return out;
}
