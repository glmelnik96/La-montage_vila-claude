// Pure planning for rippleinsert.mjs: where every item, marker and the In/Out land when gaps of
// d seconds open at times `at` on every track. All values are seconds on the frame grid.
//
// - An item starting at or after `at` moves right by the sum of the gaps at or before its start.
// - A still (or adjustment layer, or graphic) that crosses `at` keeps its start and grows by d, so
//   one clip spans the gap.
// - A clip on an `extend` track (music) that crosses `at`, or starts exactly on it, grows by d
//   instead of moving: the music plays on through the gap, and music that opens a block opens with
//   the card in the gap.
// - Any other clip crossing `at` is returned in `crossing`: the caller stops (pick `at` on an edit
//   point, or razor first).
// - Transitions (track.transitions) move like the clip they sit on: TrackItem.move() leaves them
//   behind, and a fade left behind can make its clip play the wrong part of its source. One that
//   crosses `at` is returned in `crossing` too.
const EPS = 0.005;
const r3 = (x) => Math.round(x * 1000) / 1000;

export function planInserts(items, markers, inserts, { extend = [], inP = null, outP = null, transitions = [], eps = EPS } = {}) {
  const ins = [...inserts].map((i) => ({ at: +i.at, d: +i.d })).sort((a, b) => a.at - b.at);
  for (const i of ins) if (!(i.d > 0)) throw new Error(`insert at ${i.at}: d must be > 0`);
  const upTo = (x) => ins.reduce((s, i) => s + (i.at <= x + eps ? i.d : 0), 0);     // gaps at or before x
  const before = (x) => ins.reduce((s, i) => s + (i.at < x - eps ? i.d : 0), 0);    // gaps strictly before x
  const ext = new Set(extend.map((s) => String(s).toUpperCase()));
  const moves = [], grows = [], crossing = [];
  for (const it of items) {
    const label = (it.k === 'v' ? 'V' : 'A') + (it.tr + 1);
    const onExt = ext.has(label);
    const spans = ins.filter((i) => it.en > i.at + eps && (onExt ? it.st <= i.at + eps : it.st < i.at - eps));
    if (spans.length && !onExt && !it.still) { crossing.push({ id: it.id, label, name: it.name, st: it.st, en: it.en, at: spans.map((i) => i.at) }); continue; }
    if (spans.length) {
      const st = r3(it.st + (onExt ? before(it.st) : upTo(it.st)));
      const en = r3(it.en + before(it.en));
      if (Math.abs(st - it.st) > eps) moves.push({ id: it.id, label, name: it.name, st: it.st, tg: st });
      grows.push({ id: it.id, label, name: it.name, media: !it.still, st0: it.st, st, en: r3(it.en + (st - it.st)), tgEn: en });
    } else {
      const sh = upTo(it.st);
      if (sh > eps) moves.push({ id: it.id, label, name: it.name, st: it.st, tg: r3(it.st + sh) });
    }
  }
  // descending start: no item passes another, so every track's item list stays in time order
  moves.sort((a, b) => b.st - a.st);
  const tmoves = [];
  for (const t of transitions) {
    const label = (t.k === 'v' ? 'V' : 'A') + (t.tr + 1);
    const across = ins.filter((i) => t.st < i.at - eps && t.en > i.at + eps);
    if (across.length) { crossing.push({ id: t.id, label, name: t.name, st: t.st, en: t.en, at: across.map((i) => i.at), transition: true }); continue; }
    // the head fade of music that grows from exactly a gap stays with its clip, which does not move
    const headOfGrown = grows.some((g) => g.label === label && g.media && Math.abs(g.st0 - t.st) < eps && ins.some((i) => Math.abs(i.at - t.st) < eps));
    const sh = headOfGrown ? before(t.st) : upTo(t.st);
    if (sh > eps) tmoves.push({ k: t.k, tr: t.tr, label, name: t.name, st: t.st, en: t.en, tg: r3(t.st + sh) });
  }
  tmoves.sort((a, b) => b.st - a.st);
  const marks = markers.filter((m) => upTo(m.st) > eps).map((m) => ({ ...m, tg: r3(m.st + upTo(m.st)) })).sort((a, b) => b.st - a.st);
  return {
    inserts: ins, total: r3(ins.reduce((s, i) => s + i.d, 0)), moves, grows, crossing, marks, tmoves,
    inTg: inP == null || inP < 0 ? inP : r3(inP + upTo(inP)),
    outTg: outP == null || outP < 0 ? outP : r3(outP + before(outP)),
  };
}
