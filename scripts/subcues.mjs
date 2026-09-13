// Build subtitle cues (SRT) from hand-corrected text aligned to ASR word times.
//
//   node scripts/subcues.mjs --spec spec.json --words words.json --out subs.srt [--report report.json]
//
// spec.json:
// {
//   "fps": 25, "maxChars": 42, "maxLines": 2, "maxCps": 17, "minDur": 1.0, "maxDur": 6.5,
//   "gap": 0.08, "leadIn": 0.1, "tail": 0.35, "snap": 0.25,
//   "cuts": [t, ...],                                  optional shot cuts to snap cue edges to
//   "fragments": [ { "a": 10.8, "b": 46.24,
//                    "cues": ["first cue", "second cue with a / manual line break", ...] } ]
// }
// words.json: [{ "s": 12.3, "e": 12.6, "w": "слово" }, ...]   (any ASR with word times)
//
// Cue boundaries are editorial, so they come from the spec; the script only finds
// WHEN each cue is spoken. Each cue's words are aligned (edit distance on normalised
// tokens) to the ASR words of its fragment, so a corrected or re-spelled word still
// inherits the time of the word the recogniser heard.
//
// Timing rules: lead-in before the first word, tail after the last; at least minDur
// and at most maxCps characters per second, extended into free time only; a gap of
// at least `gap` between cues; edges within `snap` of a shot cut move onto the cut;
// everything clamped to its fragment and quantised to frames.
import { readFileSync, writeFileSync } from 'node:fs';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const spec = JSON.parse(readFileSync(arg('spec'), 'utf8'));
const words = JSON.parse(readFileSync(arg('words'), 'utf8'));
const C = Object.assign({ fps: 25, maxChars: 42, maxLines: 2, maxCps: 17, minDur: 1.0, maxDur: 6.5,
  gap: 0.08, leadIn: 0.1, tail: 0.35, snap: 0.25, cuts: [] }, spec);
const q = (t) => Math.round(t * C.fps) / C.fps;
const norm = (w) => w.toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]/gi, '');

// --- alignment -----------------------------------------------------------------
function lev(a, b) {
  const m = a.length, n = b.length, d = Array.from({ length: m + 1 }, (_, i) => [i]);
  for (let j = 1; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[m][n];
}
const subCost = (x, y) => (x === y ? 0 : Math.min(1, lev(x, y) / Math.max(x.length, y.length, 1)));
// Global alignment of corrected tokens T to ASR tokens A; returns for each T index the A index or -1.
function align(T, A) {
  const m = T.length, n = A.length, G = 0.7;
  const D = Array.from({ length: m + 1 }, () => new Float64Array(n + 1));
  const P = Array.from({ length: m + 1 }, () => new Int8Array(n + 1));
  for (let i = 1; i <= m; i++) { D[i][0] = i * G; P[i][0] = 1; }
  for (let j = 1; j <= n; j++) { D[0][j] = j * G; P[0][j] = 2; }
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) {
    const s = D[i - 1][j - 1] + subCost(T[i - 1], A[j - 1]), u = D[i - 1][j] + G, l = D[i][j - 1] + G;
    if (s <= u && s <= l) { D[i][j] = s; P[i][j] = 0; } else if (u <= l) { D[i][j] = u; P[i][j] = 1; } else { D[i][j] = l; P[i][j] = 2; }
  }
  const map = new Array(m).fill(-1);
  for (let i = m, j = n; i > 0 || j > 0;) {
    if (i > 0 && j > 0 && P[i][j] === 0) { if (subCost(T[i - 1], A[j - 1]) < 0.75) map[i - 1] = j - 1; i--; j--; }
    else if (i > 0 && (j === 0 || P[i][j] === 1)) i--; else j--;
  }
  return map;
}

// --- line breaking (balanced, no dangling glue word at a line end) -----------------
const GLUE = new Set(('в во на над под по за к ко с со о об от до из у для без при про через между перед ' +
  'и а но да или либо что чтобы как когда если чем то не ни же бы ли уж').split(' '));
function breakLines(text) {
  if (text.includes(' / ')) return text.split(' / ').map((s) => s.trim());
  if (text.length <= C.maxChars) return [text];
  const w = text.split(' ');
  let best = null;
  for (let k = 1; k < w.length; k++) {
    const l1 = w.slice(0, k).join(' '), l2 = w.slice(k).join(' ');
    if (l1.length > C.maxChars || l2.length > C.maxChars) continue;
    let pen = Math.abs(l1.length - l2.length) + (l1.length > l2.length ? 4 : 0);   // prefer a bottom-heavy pair
    if (GLUE.has(norm(w[k - 1]))) pen += 100;                                        // «…в / доме»
    if (/[.,!?:;…]$/.test(w[k - 1])) pen -= 12;                                     // break after punctuation
    if (!best || pen < best.pen) best = { pen, lines: [l1, l2] };
  }
  return best ? best.lines : null;
}

// --- build ---------------------------------------------------------------------------
const cues = [], warn = [];
for (const f of C.fragments) {
  const A = words.filter((x) => x.e > f.a - 1 && x.s < f.b + 1);
  const An = A.map((x) => norm(x.w));
  const T = [], owner = [];
  f.cues.forEach((c, ci) => c.replace(/ \/ /g, ' ').split(/\s+/).filter(Boolean).forEach((t) => {
    const n = norm(t); if (n) { T.push(n); owner.push(ci); } }));
  const map = align(T, An);
  f.cues.forEach((c, ci) => {
    const idx = map.map((m, k) => (owner[k] === ci ? m : -1)).filter((m) => m >= 0);
    const text = c.replace(/\s+/g, ' ').trim();
    if (!idx.length) { warn.push(`no timing for «${text}»`); return; }
    const s0 = A[Math.min(...idx)].s, e0 = A[Math.max(...idx)].e;
    const lines = breakLines(text);
    if (!lines || lines.length > C.maxLines) warn.push(`does not fit ${C.maxLines}x${C.maxChars}: «${text}»`);
    cues.push({ frag: f, text, lines: lines || [text], s0, e0, start: Math.max(f.a, s0 - C.leadIn), end: Math.min(f.b, e0 + C.tail) });
  });
}
cues.sort((x, y) => x.start - y.start);
for (let i = 0; i < cues.length; i++) {
  const c = cues[i], prev = cues[i - 1], next = cues[i + 1];
  const lo = Math.max(c.frag.a, prev && prev.frag === c.frag ? prev.end + C.gap : -1);
  const hi = Math.min(c.frag.b, next && next.frag === c.frag ? next.start - C.gap : 1e9);
  c.start = Math.max(c.start, lo);
  const need = Math.max(C.minDur, c.text.replace(/ \/ /g, ' ').length / C.maxCps);
  if (c.end - c.start < need) c.end = Math.min(hi, c.start + need);
  if (c.end - c.start < need) c.start = Math.max(lo, c.end - need);
  for (const cut of C.cuts) {
    if (Math.abs(c.end - cut) < C.snap && cut - c.start >= C.minDur && cut <= hi && cut >= c.e0) c.end = cut;
    if (Math.abs(c.start - cut) < C.snap && c.end - cut >= C.minDur && cut >= lo && cut <= c.s0) c.start = cut;
  }
  c.start = q(c.start); c.end = q(Math.min(c.end, hi));
  if (next && next.frag === c.frag && c.end > next.start - C.gap) c.end = q(next.start - C.gap);
  const dur = c.end - c.start, cps = c.text.length / dur;
  if (dur < C.minDur - 1e-6) warn.push(`${dur.toFixed(2)} s is short: «${c.text}»`);
  if (dur > C.maxDur) warn.push(`${dur.toFixed(2)} s is long: «${c.text}»`);
  if (cps > C.maxCps + 0.5) warn.push(`${cps.toFixed(1)} cps is fast: «${c.text}»`);
  c.dur = +dur.toFixed(2); c.cps = +cps.toFixed(1);
}
const ts = (t) => { const ms = Math.round(t * 1000), h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60,
  s = Math.floor(ms / 1000) % 60; return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`; };
const srt = cues.map((c, i) => `${i + 1}\r\n${ts(c.start)} --> ${ts(c.end)}\r\n${c.lines.join('\r\n')}\r\n`).join('\r\n');
writeFileSync(arg('out'), '﻿' + srt, 'utf8');
if (arg('report')) writeFileSync(arg('report'), JSON.stringify(cues.map((c) => ({ start: c.start, end: c.end, dur: c.dur, cps: c.cps, lines: c.lines })), null, 1));
console.error(`${cues.length} cues -> ${arg('out')}`);
for (const w of warn) console.error('  WARN ' + w);
