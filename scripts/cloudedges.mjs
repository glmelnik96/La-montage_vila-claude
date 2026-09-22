// Read every edge of a cut list back through the Cloud.ru Whisper endpoint: the first and the
// last few seconds of each piece, transcribed on their own. Which words are present is reliable
// even when timestamps are not — a piece that opens on «…а также» or closes on «Совет для» shows
// up here and nowhere else.
//
//   node scripts/cloudedges.mjs --wav-dir <dir of C###.wav> --pieces pieces.json --out edges.json [--span 3]
//   pieces.json: [{"key": "B01.0", "clip": "C043", "a": 3.26, "b": 35.9}, ...]   (source seconds)
//   edges.json:  [{"key", "head": "first words…", "tail": "…last words"}]
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const WAVDIR = arg('wav-dir'), PIECES = JSON.parse(readFileSync(arg('pieces'), 'utf8')), OUT = arg('out');
const SPAN = +arg('span', 3), PAR = +arg('par', 6);
const cfg = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
const KEY = (readFileSync(join(cfg.repos.llmChatPr, 'client/shared/fm-secrets.js'), 'utf8').match(/apiKey\s*:\s*['"]([^'"]+)['"]/) || [])[1];
const URL_TR = 'https://foundation-models.api.cloud.ru/v1/audio/transcriptions';

const wavs = {};
function wav(clip) {
  if (wavs[clip]) return wavs[clip];
  const b = readFileSync(join(WAVDIR, clip + '.wav'));
  let off = 12, sr = 16000, pcm = null;
  while (off < b.length - 8) {
    const id = b.toString('ascii', off, off + 4), size = b.readUInt32LE(off + 4);
    if (id === 'fmt ') sr = b.readUInt32LE(off + 12);
    if (id === 'data') { pcm = new Int16Array(b.buffer, b.byteOffset + off + 8, Math.floor(Math.min(size, b.length - off - 8) / 2)); break; }
    off += 8 + size + (size & 1);
  }
  return (wavs[clip] = { sr, pcm });
}
function blob({ sr, pcm }, a, b) {
  const s = pcm.subarray(Math.max(0, Math.floor(a * sr)), Math.min(pcm.length, Math.ceil(b * sr)));
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + s.length * 2, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(sr, 24);
  h.writeUInt32LE(sr * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(s.length * 2, 40);
  return new Blob([h, Buffer.from(s.buffer, s.byteOffset, s.length * 2)], { type: 'audio/wav' });
}
async function asr(w, a, b) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    const form = new FormData();
    form.append('file', blob(w, a, b), 'x.wav');
    form.append('model', 'openai/whisper-large-v3');
    form.append('language', 'ru');
    form.append('response_format', 'json');
    form.append('temperature', '0.1');
    try {
      const r = await fetch(URL_TR, { method: 'POST', headers: { Authorization: 'Bearer ' + KEY }, body: form });
      if (r.ok) return String((await r.json()).text || '').trim();
    } catch {}
    await new Promise((res) => setTimeout(res, 1200 * attempt));
  }
  return '';
}

const out = [];
let next = 0;
await Promise.all(Array.from({ length: PAR }, async () => {
  while (next < PIECES.length) {
    const p = PIECES[next++], w = wav(p.clip);
    const head = await asr(w, p.a, Math.min(p.b, p.a + SPAN));
    const tail = await asr(w, Math.max(p.a, p.b - SPAN), p.b);
    out.push({ key: p.key, clip: p.clip, a: p.a, b: p.b, head, tail });
  }
}));
out.sort((x, y) => x.key.localeCompare(y.key, 'en', { numeric: true }));
writeFileSync(OUT, JSON.stringify(out, null, 1));
console.error(`${out.length} pieces read back`);
