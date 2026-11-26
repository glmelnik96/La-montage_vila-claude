// Editorial context on the source clock. Input boundaries have already been snapped.
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { pauses, check } from './audio.mjs';

const round = t => Number(t.toFixed(3));
const ending = w => /[.!?]["'»”)]*$/u.test(w) && !/(?:\.\.\.|…|\b(?:Mr|Mrs|Dr|e\.g|i\.e)\.)["'»”)]*$/iu.test(w);
const dangling = w => /^(и|но|потому|чтобы|что|если|который|которая|которое|в|на|для|это|and|but|because|if|the|with|to)$/iu.test(w.replace(/[^\p{L}]/gu,''));
const continuation = w => /^(котор(?:ый|ая|ое|ые)|чтобы|поскольку|because|which|whose)$/iu.test(w.replace(/[^\p{L}]/gu,''));
const text = ws => ws.map(w => w.w).join(' ');

export function sourceWords(input, origin = 0) {
  if (!Array.isArray(input) || !Number.isFinite(origin) || origin < 0) throw Error('Expected timed words and a nonnegative source origin');
  let previous = -Infinity;
  return input.map(w => {
    if (!Number.isFinite(w.s) || !Number.isFinite(w.e) || w.s < previous || w.s < 0 || w.e < w.s || typeof w.w !== 'string' || !w.w.trim())
      throw Error('Expected ordered word-level {s,e,w} records from transcribe_local.py');
    previous = w.s;
    return { ...w, s: round(w.s+origin), e: round(w.e+origin) };
  });
}

// Nearest *interword* pause to a transcript sentence end. An unrestricted snap
// can jump to the middle of the next thought. Small tolerance allows ASR drift.
export function evidencePause(gaps, last, next) {
  const left = last.e, right = next.s;
  if (right < left - 0.24 || right - left > 8) return null;
  const target = (left + Math.min(left+0.6,right))/2;
  const candidates = gaps.map(g => {
    const lo = Math.max(g.s, left-0.12), hi = Math.min(g.e, right+0.12);
    return hi-lo >= 0.02 ? {t:round((lo+hi)/2),pause:g} : null;
  }).filter(Boolean);
  return candidates.sort((a,b) => Math.abs(a.t-target)-Math.abs(b.t-target))[0] || null;
}

export function inspectEdge(words, t, side, gaps = [], horizon = 12) {
  let i = words.findIndex(w => (w.s+w.e)/2 > t);
  if (i < 0) i = words.length;
  const left = words[i-1], right = words[i];
  const through = words.find(w => w.s+0.055 < t && t < w.e-0.055);
  const before = words.slice(Math.max(0,i-14),i), after = words.slice(i,i+14);
  const result = {t, side, before, after, status:'candidate', reasons:[], alternatives:[]};
  if (!left || !right || t-left.e > 8 || right.s-t > 8) {
    result.status = 'unknown'; result.reasons.push('missing-adjacent-transcript'); return result;
  }
  if (through) result.reasons.push('inside-asr-word: '+through.w);
  if (!ending(left.w)) result.reasons.push('no-sentence-end-before-cut');
  if (dangling(left.w)) result.reasons.push('open-construction-on-left');
  if (continuation(right.w)) result.reasons.push('dependent-clause-on-right');
  if (left.p < .45 || right.p < .45) result.reasons.push('low-word-confidence');
  if (result.reasons.length) result.status = 'review';
  if (result.status === 'candidate') return result;
  // For an OUT scan forward; for an IN scan backward to recover the opening.
  const direction = side === 'out' ? 1 : -1;
  for (let j = side === 'out' ? i-1 : i-2; j >= 0 && j+1 < words.length; j += direction) {
    const end = words[j], next = words[j+1];
    if ((end.e-t)*direction > horizon) break;
    if (!ending(end.w) || dangling(end.w) || continuation(next.w) || end.p < .45) continue;
    const gap = evidencePause(gaps,end,next);
    if (!gap || (gap.t-t)*direction <= .04 || Math.abs(gap.t-t)>horizon) continue;
    result.alternatives.push({...gap, last:end, next, excerpt:text(words.slice(Math.max(0,j-6),j+1))});
    if (result.alternatives.length === 3) break;
  }
  return result;
}

export function joinContext(words, start, out, into, end) {
  // Midpoints assign a token exactly once when ASR overlaps an acoustic cut.
  // Edge reviews separately expose that timing uncertainty on the full source.
  const within = (w, a, b) => { const middle = (w.s+w.e)/2; return a <= middle && middle < b; };
  const retainedTail = out.before.filter(w => within(w,start.t,out.t));
  const omitted = words.filter(w => within(w,out.t,into.t));
  const retainedHead = into.after.filter(w => within(w,into.t,end.t));
  return {from:out.t, to:into.t, retainedTail:text(retainedTail), omitted, retainedHead:text(retainedHead),
    review:'Read together across the deletion; verify speaker, referents, contrast and meaning against the omitted words.'};
}

function main() {
  const {values:v} = parseArgs({options:Object.fromEntries(['src','words','origin','cuts','out','horizon','thresh'].map(k => [k,{type:'string'}]))});
  if (!v.src || !v.words || !v.cuts) throw Error('usage: node scripts/utterance.mjs --src master --words context.words.json --origin excerpt_start --cuts IN,OUT[,IN,OUT] [--out report.json]');
  const cuts = v.cuts.split(',').map(s => s.trim() ? Number(s) : NaN);
  const horizon = Number(v.horizon ?? 12), threshold = Number(v.thresh ?? -40);
  if (!cuts.length || cuts.length%2 || cuts.some((t,i) => !Number.isFinite(t) || t<0 || (i && t<=cuts[i-1]))) throw Error('Expected ordered nonoverlapping IN,OUT pairs in source seconds');
  if (!Number.isFinite(horizon) || horizon<=0 || !Number.isFinite(threshold)) throw Error('Invalid search horizon or threshold');
  const words = sourceWords(JSON.parse(readFileSync(v.words,'utf8').replace(/^\uFEFF/,'')),Number(v.origin ?? 0));
  const edges = cuts.map((t,i) => {
    const side = i%2 ? 'out' : 'in';
    const context = inspectEdge(words,t,side);
    if (context.status==='review') {
      const center = Math.max(0, t + (side==='out' ? 1 : -1)*horizon/2);
      const gaps = pauses(v.src, center, horizon/2+.8,threshold,.01);
      context.alternatives = inspectEdge(words,t,side,gaps,horizon).alternatives;
    }
    return {...context, acoustic:check(v.src,t,threshold)};
  });
  const joins = [];
  for (let i = 0; i+3 < edges.length; i += 2) {
    joins.push(joinContext(words,edges[i],edges[i+1],edges[i+2],edges[i+3]));
  }
  const report = {clock:'source seconds',origin:Number(v.origin ?? 0),edges,joins,
    editorialReview:'Candidate punctuation and acoustic gates are evidence. Read retained text, discarded context and listen to the combined take before accepting.'};
  const json = JSON.stringify(report,null,2)+'\n';
  if (v.out) writeFileSync(v.out,json); else process.stdout.write(json);
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode=1; }
}
