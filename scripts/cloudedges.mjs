// Read every edge of a cut list back through the Cloud.ru Whisper endpoint: the first and the
// last few seconds of each piece, transcribed on their own. Which words are present is reliable
// even when timestamps are not — a piece that opens on «…а также» or closes on «Совет для» shows
// up here and nowhere else.
//
//   node scripts/cloudedges.mjs --wav-dir <dir of C###.wav> --pieces pieces.json --out edges.json [--span 3]
//   pieces.json: [{"key": "B01.0", "clip": "C043", "a": 3.26, "b": 35.9}, ...]   (source seconds)
//   edges.json:  [{"key", "head": "first words…", "tail": "…last words"}]  [--par 6] [--lang ru]
// A failed request is recorded as "error" on the piece (never as an empty, clean-looking edge)
// and the run exits 1.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { apiKey, readWav, wavBlob, transcribe } from './lib/cloudasr.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const WAVDIR = arg('wav-dir'), PIECES = JSON.parse(readFileSync(arg('pieces'), 'utf8')), OUT = arg('out');
const SPAN = +arg('span', 3), PAR = +arg('par', 6);
let KEY;
try { KEY = apiKey(); } catch (e) { console.error(e.message); process.exit(2); }
const LANG = arg('lang', 'ru');

const wavs = {};
const wav = (clip) => wavs[clip] || (wavs[clip] = readWav(join(WAVDIR, clip + '.wav')));
const asr = async (w, a, b) => String((await transcribe(wavBlob(w, a, b), { key: KEY, lang: LANG })).text || '').trim();

const out = [];
let next = 0;
await Promise.all(Array.from({ length: PAR }, async () => {
  while (next < PIECES.length) {
    const p = PIECES[next++];
    try {
      const w = wav(p.clip);
      const head = await asr(w, p.a, Math.min(p.b, p.a + SPAN));
      const tail = await asr(w, Math.max(p.a, p.b - SPAN), p.b);
      out.push({ key: p.key, clip: p.clip, a: p.a, b: p.b, head, tail });
    } catch (e) {
      out.push({ key: p.key, clip: p.clip, a: p.a, b: p.b, error: String(e.message || e) });
    }
  }
}));
out.sort((x, y) => x.key.localeCompare(y.key, 'en', { numeric: true }));
writeFileSync(OUT, JSON.stringify(out, null, 1));
const bad = out.filter((x) => x.error);
console.error(`${out.length - bad.length} pieces read back${bad.length ? `, ${bad.length} FAILED: ${bad.map((x) => x.key).join(', ')}` : ''}`);
if (bad.length) process.exit(1);
