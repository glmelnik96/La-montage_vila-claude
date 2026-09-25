// Cloud transcription with boundaries you can cut on: split each clip's audio at its own
// pauses, send every phrase group to the Cloud.ru Whisper endpoint on its own, and keep the
// measured audio edges instead of the model's timestamps.
//
//   node scripts/cloudtr.mjs --wav-dir <dir of C###.wav, 16-bit mono> --out-dir <dir>
//        [--only C014,C050] [--jobs 6] [--min 3] [--max 15] [--gap 0.35] [--lang ru]
//   node scripts/cloudtr.mjs --wav-dir <dir> --pieces pieces.json --out result.json [--jobs 6] [--resume]
//        pieces.json: [{"key", "clip": "C043", "a": 3.28, "b": 36.1, "prompt": "names, terms"}]
//        -> {key: [{s, e, text}]}: the same phrase groups, but only inside [a, b], sent in order,
//        each with `prompt` + the tail of the previous phrase as context — a transcript of the
//        pieces of an edit, for reading. The context fixes names and terms («Семдиби» -> CMDB)
//        and carries a sentence across a chunk edge. The result file is rewritten after every
//        piece; --resume skips the keys it already holds. A piece whose requests failed gets
//        {"error"} instead of rows, and the run exits 1.
//
// Why: the endpoint (openai/whisper-large-v3 on foundation-models.api.cloud.ru) answers
// `words: null` even when asked for timestamp_granularities[]=word, and a long file comes back
// with whole 30 s windows silently missing (seen on 7 of 171 interview clips: an answer's first
// half, a speaker's introduction, one reply reduced to the question that preceded it). A phrase
// group between measured pauses (usually 3–15 s; speech with no pause for longer is split near
// every 20 s, so a chunk can reach 25 s) is one decoding window: nothing is dropped, and every
// chunk edge is a pause — a blade can go there. Only files named C<digits>.wav are read.
//
// Output per clip: <out-dir>/C###.json = [{s, e, text, lp, nsp}] in seconds of the clip's own
// audio (= source time of the media file), written only when every chunk of the clip came back;
// a clip with a failed request gets no file (a re-run picks it up) and the run exits 1. The API
// key is read from the panel's fm-secrets.js (config.json repos.llmChatPr); nothing is printed.
import { readFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { apiKey, readWav, wavBlob, transcribe, writeJsonAtomic } from './lib/cloudasr.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const WAVDIR = arg('wav-dir'), OUT = arg('out-dir'), JOBS = +arg('jobs', 6), PIECES = arg('pieces');
const MIN = +arg('min', 3), MAX = +arg('max', 15), GAP = +arg('gap', 0.35);
const only = arg('only') ? new Set(arg('only').split(',')) : null, LANG = arg('lang', 'ru');
if (!WAVDIR || (!OUT && !PIECES) || (PIECES && !arg('out'))) { console.error('usage: cloudtr.mjs --wav-dir <dir> --out-dir <dir> [--only C014] | --pieces p.json --out r.json [--resume]'); process.exit(2); }
if (OUT) mkdirSync(OUT, { recursive: true });

let KEY;
try { KEY = apiKey(); } catch (e) { console.error(e.message); process.exit(2); }
const JUNK = /продолжение следует|субтитр|корректор|редактор|dimatorzok|спасибо за просмотр|подписывайтесь|amara/i;

// 10 ms RMS in dBFS
function envelope(pcm, sr) {
  const n = Math.floor(sr / 100), out = new Float32Array(Math.floor(pcm.length / n));
  for (let f = 0; f < out.length; f++) {
    let acc = 0; for (let i = f * n; i < (f + 1) * n; i++) acc += pcm[i] * pcm[i];
    out[f] = 20 * Math.log10(Math.sqrt(acc / n) / 32768 + 1e-9);
  }
  return out;
}
// pauses: runs below a threshold set from this clip's own level histogram; [f0, f1) limits
// the islands to a range of 10 ms frames (a piece of an edit) while the threshold stays the clip's
function chunksOf(db, f0 = 0, f1 = db.length) {
  const sorted = Array.from(db).sort((a, b) => a - b);
  const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  const floor = q(0.05), speech = q(0.7);
  const T = Math.min(floor + 10, speech - 12);
  const voiced = Array.from(db, (v, k) => k >= f0 && k < f1 && v > T);
  // islands of speech separated by >= 0.2 s of quiet
  const isl = [];
  let i = f0;
  while (i < f1) {
    while (i < f1 && !voiced[i]) i++;
    if (i >= f1) break;
    let j = i, quiet = 0, last = i;
    while (j < f1 && quiet < 20) { if (voiced[j]) { quiet = 0; last = j; } else quiet++; j++; }
    if (last - i >= 8) isl.push([i / 100, (last + 1) / 100]);   // ignore clicks shorter than 80 ms
    i = last + 1;
  }
  // group islands into 3–15 s chunks, preferring to break on the longer pauses
  const chunks = [];
  let cur = null;
  for (let k = 0; k < isl.length; k++) {
    const [a, b] = isl[k];
    if (!cur) { cur = [a, b]; continue; }
    const gap = a - cur[1], len = cur[1] - cur[0];
    if ((len >= MIN && gap >= GAP) || b - cur[0] > MAX) { chunks.push(cur); cur = [a, b]; }
    else cur[1] = b;
  }
  if (cur) chunks.push(cur);
  // an island with no pause for > 25 s is split at its quietest 10 ms near every 20 s
  const out = [];
  for (const [a, b] of chunks) {
    let s = a;
    while (b - s > 25) {
      let best = s + 20, bv = 1e9;
      for (let t = s + 15; t < Math.min(b - 2, s + 24); t += 0.01) { const v = db[Math.round(t * 100)]; if (v < bv) { bv = v; best = t; } }
      out.push([s, best]); s = best;
    }
    out.push([s, b]);
  }
  return { chunks: out, T: Math.round(T * 10) / 10, floor: Math.round(floor * 10) / 10 };
}
const post = (blob, name, prompt) => transcribe(blob, { key: KEY, name, prompt, format: 'verbose_json', lang: LANG });

if (PIECES) {
  // pieces of an edit: chunk inside each piece, transcribe its chunks in order with context
  const list = JSON.parse(readFileSync(PIECES, 'utf8'));
  const wavs = {};
  const load = (clip) => {
    if (!wavs[clip]) { const w = readWav(join(WAVDIR, clip + '.wav')); wavs[clip] = { ...w, db: envelope(w.pcm, w.sr) }; }
    return wavs[clip];
  };
  const OUTF = arg('out');
  const result = process.argv.includes('--resume') && existsSync(OUTF) ? JSON.parse(readFileSync(OUTF, 'utf8')) : {};
  const todo = list.filter((p) => !Array.isArray(result[p.key]));
  if (todo.length < list.length) console.error(`resume: ${list.length - todo.length} pieces already done`);
  let nextP = 0, doneP = 0;
  const failed = [];
  await Promise.all(Array.from({ length: JOBS }, async () => {
    while (nextP < todo.length) {
      const p = todo[nextP++];
      try {
        const w = load(p.clip), dur = w.pcm.length / w.sr;
        let { chunks } = chunksOf(w.db, Math.floor(p.a * 100), Math.ceil(p.b * 100));
        if (!chunks.length) chunks = [[p.a, p.b]];
        const rows = [];
        let prev = '';
        // Each phrase group is read twice: with the context (names and terms come out right) and
        // without it (a prompt can derail a quiet phrase into invented text — «будут в следующем
        // году» for «останутся фундаментальными»). The reading with the better mean log-probability
        // wins, the prompted one on a near tie; an implausibly sparse reading (< 6 chars/s) loses.
        const read = async (a0, b0, ctx) => {
          const d = await post(wavBlob(w, a0, b0), `${p.key}.wav`, ctx);
          const segs = d.segments || [];
          const n = segs.reduce((x, g) => x + Math.max(0.01, (g.end ?? 0) - (g.start ?? 0)), 0);
          const lp = segs.length ? segs.reduce((x, g) => x + (g.avg_logprob ?? -1) * Math.max(0.01, (g.end ?? 0) - (g.start ?? 0)), 0) / n : -9;
          let text = String(d.text || '').trim();
          if (JUNK.test(text) && b0 - a0 < 4) text = '';
          return { text, lp };
        };
        // Whisper copies the style of its prompt: an unpunctuated lower-case phrase used as context
        // makes the next one come back the same way, and a run of them spreads through an answer
        // (10 % of the phrases of one job). So a long unpunctuated phrase (> 60 characters) is never
        // used as context, the prompt carries a punctuated style sample, and a punctuated reading
        // beats an unpunctuated one of similar length. A phrase that comes back implausibly sparse
        // in both readings is flagged `sparse`: re-read it in ~7 s windows (--pieces over sub-ranges).
        const STYLE = 'Вот как это выглядит: мы работаем с клиентами, помогаем им правильно осваивать технологии. Это важно.';
        const punct = (t) => (t.match(/[.,!?—:;]/g) || []).length / Math.max(1, t.length) * 100;
        const bare = (t) => t.length > 60 && punct(t) < 0.9;
        for (const [a, b] of chunks) {
          const pa = Math.max(p.a, a - 0.12), pb = Math.min(p.b, dur, b + 0.12);
          const ctx = [p.prompt || '', STYLE, bare(prev) ? '' : prev.slice(-160)].filter(Boolean).join(' ');
          const A = await read(pa, pb, ctx), B = await read(pa, pb, '');
          const ok = (r) => r.text.length / Math.max(0.5, b - a) >= 6 || (b - a < 2 && r.text.length > 0);
          const similar = A.text.length && B.text.length / A.text.length > 0.7 && B.text.length / A.text.length < 1.4;
          let pick = A, alt = B;
          if (ok(A) && ok(B)) {
            if (bare(A.text) && !bare(B.text) && similar) { pick = B; alt = A; }
            else if (!(bare(B.text) && !bare(A.text) && similar) && B.lp > A.lp + 0.15) { pick = B; alt = A; }
          }
          else if (!ok(A) && ok(B)) { pick = B; alt = A; }
          else if (!ok(A) && !ok(B) && B.text.length > A.text.length) { pick = B; alt = A; }
          rows.push({ s: +a.toFixed(2), e: +b.toFixed(2), text: pick.text, lp: +pick.lp.toFixed(3), alt: alt.text,
            flag: !ok(pick) ? 'sparse' : bare(pick.text) ? 'unpunctuated' : undefined });
          if (pick.text) prev = pick.text;
        }
        result[p.key] = rows;
      } catch (e) {
        result[p.key] = { error: String(e.message || e) };
        failed.push(p.key);
        console.error(`  FAILED ${p.key}: ${e.message}`);
      }
      writeJsonAtomic(OUTF, result, 1);
      if (++doneP % 10 === 0) console.error(`  ${doneP}/${todo.length} pieces`);
    }
  }));
  writeJsonAtomic(OUTF, result, 1);
  console.error(`done: ${Object.keys(result).length} pieces${failed.length ? `, ${failed.length} FAILED (re-run with --resume): ${failed.join(', ')}` : ''}`);
  process.exit(failed.length ? 1 : 0);
}

const files = readdirSync(WAVDIR).filter((f) => /^C\d+\.wav$/.test(f) && (!only || only.has(f.replace('.wav', ''))));
const tasks = [];
const perClip = {};
for (const f of files) {
  const id = f.replace('.wav', '');
  if (!only && existsSync(join(OUT, id + '.json'))) continue;
  const { sr, pcm } = readWav(join(WAVDIR, f));
  const db = envelope(pcm, sr);
  const { chunks, T, floor } = chunksOf(db);
  const dur = pcm.length / sr;
  perClip[id] = { n: chunks.length, left: chunks.length, rows: new Array(chunks.length), T, floor, dur, failed: false };
  chunks.forEach(([a, b], k) => {
    const pa = Math.max(0, a - 0.12), pb = Math.min(dur, b + 0.12);
    tasks.push({ id, k, a, b, blob: wavBlob({ sr, pcm }, pa, pb) });
  });
}
console.error(`${Object.keys(perClip).length} clips, ${tasks.length} chunks, ${Math.round(tasks.reduce((s, t) => s + t.b - t.a, 0))} s of speech`);
let next = 0, done = 0;
const failedClips = new Set();
async function worker() {
  while (next < tasks.length) {
    const t = tasks[next++];
    if (perClip[t.id].failed) continue;
    let d;
    try { d = await post(t.blob, `${t.id}_${t.k}.wav`); }
    catch (e) { perClip[t.id].failed = true; failedClips.add(t.id); console.error(`  FAILED ${t.id} chunk ${t.k}: ${e.message}`); continue; }
    const segs = d.segments || [];
    const lp = segs.length ? Math.min(...segs.map((s) => s.avg_logprob ?? 0)) : 0;
    const nsp = segs.length ? Math.max(...segs.map((s) => s.no_speech_prob ?? 0)) : 0;
    let text = String(d.text || '').trim();
    if (JUNK.test(text) && t.b - t.a < 4) text = '';
    perClip[t.id].rows[t.k] = { s: +t.a.toFixed(2), e: +t.b.toFixed(2), text, lp: +lp.toFixed(3), nsp: +(nsp || 0).toFixed(3) };
    if (++done % 50 === 0) console.error(`  ${done}/${tasks.length}`);
    const pc = perClip[t.id];
    if (--pc.left === 0 && !pc.failed) writeJsonAtomic(join(OUT, t.id + '.json'), { T: pc.T, floor: pc.floor, dur: pc.dur, rows: pc.rows });
  }
}
await Promise.all(Array.from({ length: JOBS }, worker));
console.error(`done: ${done} chunks${failedClips.size ? `; FAILED clips, no file written (re-run): ${[...failedClips].join(', ')}` : ''}`);
process.exit(failedClips.size ? 1 : 0);
