// Cloud transcription with boundaries you can cut on: split each clip's audio at its own
// pauses, send every phrase group to the Cloud.ru Whisper endpoint on its own, and keep the
// measured audio edges instead of the model's timestamps.
//
//   node scripts/cloudtr.mjs --wav-dir <dir of C###.wav, 16 kHz mono> --out-dir <dir>
//        [--only C014,C050] [--jobs 6] [--min 3] [--max 15] [--gap 0.35]
//   node scripts/cloudtr.mjs --wav-dir <dir> --pieces pieces.json --out result.json [--jobs 6]
//        pieces.json: [{"key", "clip": "C043", "a": 3.28, "b": 36.1, "prompt": "names, terms"}]
//        -> {key: [{s, e, text}]}: the same phrase groups, but only inside [a, b], sent in order,
//        each with `prompt` + the tail of the previous phrase as context — a transcript of the
//        pieces of an edit, for reading. The context fixes names and terms («Семдиби» -> CMDB)
//        and carries a sentence across a chunk edge.
//
// Why: the endpoint (openai/whisper-large-v3 on foundation-models.api.cloud.ru) answers
// `words: null` even when asked for timestamp_granularities[]=word, and a long file comes back
// with whole 30 s windows silently missing (seen on 7 of 171 interview clips: an answer's first
// half, a speaker's introduction, one reply reduced to the question that preceded it). A phrase
// group of 3–15 s between measured pauses is one decoding window: nothing is dropped, and every
// chunk edge is a pause — a blade can go there.
//
// Output per clip: <out-dir>/C###.json = [{s, e, text, lp, nsp}] in seconds of the clip's own
// audio (= source time of the media file). The API key is read from the panel's fm-secrets.js
// (config.json repos.llmChatPr); nothing is printed.
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const WAVDIR = arg('wav-dir'), OUT = arg('out-dir'), JOBS = +arg('jobs', 6), PIECES = arg('pieces');
const MIN = +arg('min', 3), MAX = +arg('max', 15), GAP = +arg('gap', 0.35);
const only = arg('only') ? new Set(arg('only').split(',')) : null;
if (!WAVDIR || (!OUT && !PIECES)) { console.error('usage: cloudtr.mjs --wav-dir <dir> --out-dir <dir> [--only C014] | --pieces p.json --out r.json'); process.exit(2); }
if (OUT) mkdirSync(OUT, { recursive: true });

const cfg = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
const sec = readFileSync(join(cfg.repos.llmChatPr, 'client/shared/fm-secrets.js'), 'utf8');
const KEY = (sec.match(/apiKey\s*:\s*['"]([^'"]+)['"]/) || [])[1];
if (!KEY) { console.error('no apiKey in fm-secrets.js'); process.exit(2); }
const URL_TR = 'https://foundation-models.api.cloud.ru/v1/audio/transcriptions';
const JUNK = /продолжение следует|субтитр|корректор|редактор|dimatorzok|спасибо за просмотр|подписывайтесь|amara/i;

function readWav(p) {
  const b = readFileSync(p);
  let off = 12, sr = 16000, data = null;
  while (off < b.length - 8) {
    const id = b.toString('ascii', off, off + 4), size = b.readUInt32LE(off + 4);
    if (id === 'fmt ') sr = b.readUInt32LE(off + 12);
    if (id === 'data') { data = new Int16Array(b.buffer, b.byteOffset + off + 8, Math.floor(Math.min(size, b.length - off - 8) / 2)); break; }
    off += 8 + size + (size & 1);
  }
  return { sr, pcm: data };
}
function wavBlob(pcm, sr, a, b) {
  const s = pcm.subarray(Math.max(0, Math.floor(a * sr)), Math.min(pcm.length, Math.ceil(b * sr)));
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + s.length * 2, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(sr, 24);
  h.writeUInt32LE(sr * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(s.length * 2, 40);
  return new Blob([h, Buffer.from(s.buffer, s.byteOffset, s.length * 2)], { type: 'audio/wav' });
}
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
async function post(blob, name, prompt) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    const form = new FormData();
    form.append('file', blob, name);
    form.append('model', 'openai/whisper-large-v3');
    form.append('language', 'ru');
    form.append('response_format', 'verbose_json');
    form.append('temperature', '0.1');
    if (prompt) form.append('prompt', prompt);
    try {
      const r = await fetch(URL_TR, { method: 'POST', headers: { Authorization: 'Bearer ' + KEY }, body: form });
      const t = await r.text();
      if (r.ok) return JSON.parse(t);
      if (r.status < 500 && r.status !== 429) throw new Error(`HTTP ${r.status}: ${t.slice(0, 200)}`);
    } catch (e) { if (attempt === 5) throw e; }
    await new Promise((res) => setTimeout(res, 1500 * attempt));
  }
}

if (PIECES) {
  // pieces of an edit: chunk inside each piece, transcribe its chunks in order with context
  const list = JSON.parse(readFileSync(PIECES, 'utf8'));
  const wavs = {};
  const load = (clip) => {
    if (!wavs[clip]) { const w = readWav(join(WAVDIR, clip + '.wav')); wavs[clip] = { ...w, db: envelope(w.pcm, w.sr) }; }
    return wavs[clip];
  };
  const result = {};
  let nextP = 0, doneP = 0;
  await Promise.all(Array.from({ length: JOBS }, async () => {
    while (nextP < list.length) {
      const p = list[nextP++], w = load(p.clip), dur = w.pcm.length / w.sr;
      let { chunks } = chunksOf(w.db, Math.floor(p.a * 100), Math.ceil(p.b * 100));
      if (!chunks.length) chunks = [[p.a, p.b]];
      const rows = [];
      let prev = '';
      // Each phrase group is read twice: with the context (names and terms come out right) and
      // without it (a prompt can derail a quiet phrase into invented text — «будут в следующем
      // году» for «останутся фундаментальными»). The reading with the better mean log-probability
      // wins, the prompted one on a near tie; an implausibly sparse reading (< 6 chars/s) loses.
      const read = async (a0, b0, ctx) => {
        const d = await post(wavBlob(w.pcm, w.sr, a0, b0), `${p.key}.wav`, ctx);
        const segs = d.segments || [];
        const n = segs.reduce((x, g) => x + Math.max(0.01, (g.end ?? 0) - (g.start ?? 0)), 0);
        const lp = segs.length ? segs.reduce((x, g) => x + (g.avg_logprob ?? -1) * Math.max(0.01, (g.end ?? 0) - (g.start ?? 0)), 0) / n : -9;
        let text = String(d.text || '').trim();
        if (JUNK.test(text) && b0 - a0 < 4) text = '';
        return { text, lp };
      };
      // Whisper copies the style of its prompt: an unpunctuated lower-case phrase used as context
      // makes the next one come back the same way, and a run of them spreads through an answer
      // (10 % of the phrases of one job). So the context is the previous phrase only when it is
      // punctuated, the prompt carries a punctuated style sample, and a punctuated reading beats
      // an unpunctuated one of similar length.
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
      if (++doneP % 10 === 0) console.error(`  ${doneP}/${list.length} pieces`);
    }
  }));
  writeFileSync(arg('out'), JSON.stringify(result, null, 1));
  console.error(`done: ${Object.keys(result).length} pieces`);
  process.exit(0);
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
  perClip[id] = { n: chunks.length, rows: new Array(chunks.length), T, floor, dur };
  chunks.forEach(([a, b], k) => {
    const pa = Math.max(0, a - 0.12), pb = Math.min(dur, b + 0.12);
    tasks.push({ id, k, a, b, blob: wavBlob(pcm, sr, pa, pb) });
  });
}
console.error(`${Object.keys(perClip).length} clips, ${tasks.length} chunks, ${Math.round(tasks.reduce((s, t) => s + t.b - t.a, 0))} s of speech`);
let next = 0, done = 0;
async function worker() {
  while (next < tasks.length) {
    const t = tasks[next++];
    const d = await post(t.blob, `${t.id}_${t.k}.wav`);
    const segs = d.segments || [];
    const lp = segs.length ? Math.min(...segs.map((s) => s.avg_logprob ?? 0)) : 0;
    const nsp = segs.length ? Math.max(...segs.map((s) => s.no_speech_prob ?? 0)) : 0;
    let text = String(d.text || '').trim();
    if (JUNK.test(text) && t.b - t.a < 4) text = '';
    perClip[t.id].rows[t.k] = { s: +t.a.toFixed(2), e: +t.b.toFixed(2), text, lp: +lp.toFixed(3), nsp: +(nsp || 0).toFixed(3) };
    if (++done % 50 === 0) console.error(`  ${done}/${tasks.length}`);
    const pc = perClip[t.id];
    if (pc.rows.every(Boolean)) writeFileSync(join(OUT, t.id + '.json'), JSON.stringify({ T: pc.T, floor: pc.floor, dur: pc.dur, rows: pc.rows }));
  }
}
await Promise.all(Array.from({ length: JOBS }, worker));
console.error(`done: ${done} chunks`);
