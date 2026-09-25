// Shared plumbing for the Cloud.ru Whisper scripts (cloudtr, cloudsplit, cloudedges): the API
// key, 16 kHz mono WAV in and out, and one request with retries that never turns a failure into
// an empty transcript — an empty text reads as silence, and silence reads as a clean edge.
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

export const URL_TR = 'https://foundation-models.api.cloud.ru/v1/audio/transcriptions';

// The key comes from the panel's fm-secrets.js (config.json repos.llmChatPr). It is never printed.
export function apiKey() {
  const cfg = JSON.parse(readFileSync(new URL('../../config.json', import.meta.url), 'utf8'));
  const sec = readFileSync(join(cfg.repos.llmChatPr, 'client/shared/fm-secrets.js'), 'utf8');
  const key = (sec.match(/apiKey\s*:\s*['"]([^'"]+)['"]/) || [])[1];
  if (!key) throw new Error('no apiKey in fm-secrets.js');
  return key;
}

// 16-bit PCM mono only: a stereo file would double the time axis, and a 24-bit or float one
// would go out as noise. Extract with `ffmpeg -i <media> -map 0:a:0 -ac 1 -ar 16000 C001.wav`.
export function readWav(path) {
  const b = readFileSync(path);
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') throw new Error(`${path}: not a WAV file`);
  let off = 12, fmt = null, pcm = null;
  while (off < b.length - 8) {
    const id = b.toString('ascii', off, off + 4), size = b.readUInt32LE(off + 4);
    if (id === 'fmt ') fmt = { tag: b.readUInt16LE(off + 8), ch: b.readUInt16LE(off + 10), sr: b.readUInt32LE(off + 12), bits: b.readUInt16LE(off + 22) };
    if (id === 'data') { pcm = new Int16Array(b.buffer, b.byteOffset + off + 8, Math.floor(Math.min(size, b.length - off - 8) / 2)); break; }
    off += 8 + size + (size & 1);
  }
  if (!fmt || !pcm) throw new Error(`${path}: no fmt/data chunk`);
  if ((fmt.tag !== 1 && fmt.tag !== 0xfffe) || fmt.ch !== 1 || fmt.bits !== 16)
    throw new Error(`${path}: need 16-bit PCM mono, got tag ${fmt.tag}, ${fmt.ch} ch, ${fmt.bits} bit — re-extract with ffmpeg -ac 1 -ar 16000`);
  return { sr: fmt.sr, pcm };
}

export function wavBlob({ sr, pcm }, a, b) {
  const s = pcm.subarray(Math.max(0, Math.floor(a * sr)), Math.min(pcm.length, Math.ceil(b * sr)));
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + s.length * 2, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(sr, 24);
  h.writeUInt32LE(sr * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(s.length * 2, 40);
  return new Blob([h, Buffer.from(s.buffer, s.byteOffset, s.length * 2)], { type: 'audio/wav' });
}

// One transcription. A network error, 429 or 5xx is retried with backoff; any other 4xx is a bad
// key or a bad request and fails at once; the last failure is thrown.
export async function transcribe(blob, { key, name = 'x.wav', prompt = '', format = 'json', lang = 'ru', tries = 5 } = {}) {
  let last = '';
  for (let attempt = 1; attempt <= tries; attempt++) {
    const form = new FormData();
    form.append('file', blob, name);
    form.append('model', 'openai/whisper-large-v3');
    if (lang) form.append('language', lang);
    form.append('response_format', format);
    form.append('temperature', '0.1');
    if (prompt) form.append('prompt', prompt);
    let r = null, t = '';
    try {
      r = await fetch(URL_TR, { method: 'POST', headers: { Authorization: 'Bearer ' + key }, body: form });
      t = await r.text();
    } catch (e) { r = null; last = String((e && e.message) || e); }
    if (r) {
      if (r.ok) return JSON.parse(t);
      last = `HTTP ${r.status}: ${t.slice(0, 200)}`;
      if (r.status < 500 && r.status !== 429) throw new Error(last);
    }
    if (attempt < tries) await new Promise((res) => setTimeout(res, 1500 * attempt));
  }
  throw new Error(`gave up after ${tries} attempts: ${last}`);
}

// Write JSON so that a crash never leaves a half-written file behind.
export function writeJsonAtomic(path, data, space) {
  writeFileSync(path + '.tmp', JSON.stringify(data, null, space));
  renameSync(path + '.tmp', path);
}
