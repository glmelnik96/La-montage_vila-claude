// Find a cut INSIDE a transcribed phrase group: the pause right after a given word, located by
// sending prefixes of the audio to the Cloud.ru Whisper endpoint. The companion of cloudtr.mjs
// (whose chunk edges are already pauses) for the cuts that fall between two of its chunks'
// sentences: a question and the answer that follows in one breath, a restart, an aside.
//
//   node scripts/cloudsplit.mjs --wav-dir <dir of C###.wav> --jobs splits.json --out found.json
//   splits.json: [{"key": "A5a", "clip": "C021", "s": 0.03, "e": 13.06, "after": "меняться"}, ...]
//     after = the last word BEFORE the cut (for "start at X" give the word preceding X).
//     optional "t": a cut measured by hand on a level map — only read back, not searched.
//     optional "text": the chunk's transcript — places the first guess where the word should be.
//   options: --par 4 (parallel jobs), --lang ru
//   found.json: [{"key", "t", "gap": [a, b], "prefix", "suffix", "ok", "loose"?, "manual"?, "error"?}]
//     t is inside the pause: 0.10 s before the next word when the pause is long, its middle
//     when it is short. Trim the piece to sustained speech afterwards.
//     ok:false + loose:true = the word was found only SECOND to last — the cut is one word late;
//     decide by hand. A failed request is an "error", never an empty transcript; the run exits 1.
//
// How: 10 ms envelope of the chunk; every dip of >= 30 ms under the chunk's own threshold is a
// candidate. Candidates are tried nearest-first to where the word should be (by its character
// position in the chunk text); a candidate wins when the transcript of [s, candidate] ends with
// `after` as its LAST word («loose» = second to last, reported). The suffix is transcribed too:
// a prefix that ends right and a suffix that starts right is a cut that will sound clean.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { apiKey, readWav, wavBlob, transcribe } from './lib/cloudasr.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const WAVDIR = arg('wav-dir'), JOBS = JSON.parse(readFileSync(arg('jobs'), 'utf8')), OUT = arg('out'), PAR = +arg('par', 4);
let KEY;
try { KEY = apiKey(); } catch (e) { console.error(e.message); process.exit(2); }
const LANG = arg('lang', 'ru');

const wavs = {};
const wav = (clip) => wavs[clip] || (wavs[clip] = readWav(join(WAVDIR, clip + '.wav')));
const asr = async (w, a, b) => String((await transcribe(wavBlob(w, a, b), { key: KEY, lang: LANG })).text || '').trim();
const norm = (t) => t.toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const lastWords = (t, n) => norm(t).split(' ').filter(Boolean).slice(-n);
// Two spellings of one word: equal, or (both longer than 3 letters) sharing their first
// min(6, shorter) letters with lengths no more than one apart — «эффектом»/«эффектам» match,
// «атлас»/«атласом» and «да»/«дай» do not. Latin and Cyrillic spellings never match: pass
// `after` in the script the model will use (it writes «Атлас», not «Atlas»).
const same = (a, b) => {
  if (a === b) return true;
  const L = Math.min(a.length, b.length);
  if (L <= 3 || Math.abs(a.length - b.length) > 1) return false;
  let cp = 0; while (cp < L && a[cp] === b[cp]) cp++;
  return cp >= Math.min(6, L);
};

function quietRuns({ sr, pcm }, s, e) {
  const n = Math.floor(sr / 100), a0 = Math.floor(s * 100), a1 = Math.floor(e * 100);
  const db = [];
  for (let f = a0; f < a1; f++) {
    let acc = 0; for (let i = f * n; i < (f + 1) * n && i < pcm.length; i++) acc += pcm[i] * pcm[i];
    db.push(20 * Math.log10(Math.sqrt(acc / n) / 32768 + 1e-9));
  }
  const sorted = [...db].sort((x, y) => x - y);
  const speech = sorted[Math.floor(sorted.length * 0.75)], floor = sorted[Math.floor(sorted.length * 0.05)];
  // generous on purpose: a comma between two words can be 30 ms at -50 dB; the transcript,
  // not the level, decides which dip is the cut
  const th = Math.max(floor + 4, speech - 18);
  const runs = [];
  let i = 0;
  while (i < db.length) {
    if (db[i] >= th) { i++; continue; }
    let j = i; while (j < db.length && db[j] < th) j++;
    if (j - i >= 3) runs.push([(a0 + i) / 100, (a0 + j) / 100]);
    i = j;
  }
  return runs.filter(([a, b]) => a > s + 0.3 && b < e - 0.3);
}

async function solve(job) {
  const w = wav(job.clip);
  const runs = quietRuns(w, job.s, job.e);
  const target = norm(job.after).split(' ');
  const want = target[target.length - 1];
  // expected time of the word: its character share of the chunk text, when the chunk text is known
  let guess = job.s + (job.e - job.s) / 2;
  if (job.text) {
    const nt = norm(job.text), k = nt.indexOf(norm(job.after));
    if (k >= 0) guess = job.s + (job.e - job.s) * ((k + norm(job.after).length) / Math.max(1, nt.length));
  }
  const cut = (r) => ((r[1] - r[0]) > 0.25 ? Math.max(r[0] + 0.05, r[1] - 0.10) : (r[0] + r[1]) / 2);
  if (job.t !== undefined) {          // measured by hand on the level map: only read it back
    const prefix = await asr(w, job.s - 0.1, job.t), suffix = await asr(w, job.t, Math.min(job.e + 0.1, job.t + 6));
    return { key: job.key, clip: job.clip, t: job.t, manual: true, prefix: prefix.slice(-80), suffix: suffix.slice(0, 80), ok: true };
  }
  const order = runs.map((r) => ({ r, d: Math.abs((r[0] + r[1]) / 2 - guess) })).sort((x, y) => x.d - y.d).slice(0, 10);
  const tried = [];
  let loose = null;
  // the LAST word must be the target: «…для работодателя. А» is a cut one word too late
  for (const { r } of order) {
    const mid = (r[0] + r[1]) / 2;
    const prefix = await asr(w, job.s - 0.1, mid);
    const lw = lastWords(prefix, 2);
    tried.push({ at: +mid.toFixed(2), prefix: prefix.slice(-60) });
    if (lw.length && same(lw[lw.length - 1], want)) {
      const t = cut(r);
      const suffix = await asr(w, t, Math.min(job.e + 0.1, t + 6));
      return { key: job.key, clip: job.clip, t: +t.toFixed(2), gap: [r[0], r[1]], prefix: prefix.slice(-80), suffix: suffix.slice(0, 80), ok: true };
    }
    if (!loose && lw.length > 1 && same(lw[0], want)) loose = { r, prefix };
  }
  if (loose) {
    const t = cut(loose.r), suffix = await asr(w, t, Math.min(job.e + 0.1, t + 6));
    return { key: job.key, clip: job.clip, t: +t.toFixed(2), gap: loose.r, prefix: loose.prefix.slice(-80), suffix: suffix.slice(0, 80), ok: false, loose: true };
  }
  return { key: job.key, clip: job.clip, ok: false, runs: runs.map((r) => r.map((x) => +x.toFixed(2))), tried };
}

const out = [];
let next = 0, errors = 0;
await Promise.all(Array.from({ length: PAR }, async () => {
  while (next < JOBS.length) {
    const j = JOBS[next++];
    let r;
    try { r = await solve(j); }
    catch (e) { r = { key: j.key, clip: j.clip, ok: false, error: String(e.message || e) }; errors++; }
    out.push(r);
    const tag = r.error ? 'ERR ' : r.loose ? 'LOOS' : !r.ok ? 'FAIL' : r.manual ? 'man ' : 'ok  ';
    console.error(`${tag} ${j.key} ${j.clip} ${r.error ? r.error : r.t !== undefined ? r.t + '  …' + r.prefix.slice(-35) + ' | ' + r.suffix.slice(0, 35) + '…' : ''}`);
  }
}));
out.sort((a, b) => a.key.localeCompare(b.key));
writeFileSync(OUT, JSON.stringify(out, null, 1));
if (errors) { console.error(`${errors} jobs failed on the endpoint — nothing was decided for them`); process.exit(1); }
