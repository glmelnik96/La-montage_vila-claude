// Timeline-aligned audio mixdown of a sequence, rebuilt from its source media.
// Premiere cannot export audio from a script without a render, so this sums
// every audio clip at its timeline position with ffmpeg. Good enough to
// transcribe and to measure pauses; NOT a finished mix — clip gain, keyframes
// and effects are ignored.
//
//   node scripts/mixdown.mjs --clips <clips.json> --out <file.wav> [--sr 48000]
//
// clips.json: [{ "path": "...", "start": <timeline s>, "in": <source s>, "out": <source s>,
//                "ch": <source channel, optional> }, ...]
// `ch` takes ONE channel instead of downmixing: on a shoot where the lav went into a single
// input the other channel is silence, and averaging both throws away 6 dB of the voice.
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : d;
};

const clips = JSON.parse(readFileSync(arg('clips'), 'utf8'));
const out = arg('out'), sr = +arg('sr', 48000);
if (!clips.length || !out) { console.error('usage: mixdown.mjs --clips <json> --out <wav>'); process.exit(2); }
for (const c of clips) if (!existsSync(c.path)) throw new Error(`missing media: ${c.path}`);

const args = ['-v', 'error', '-y'];
const chains = [];
clips.forEach((c, k) => {
  // input-side seek: fast, and exact enough for PCM/AAC at frame precision
  args.push('-ss', c.in.toFixed(3), '-t', (c.out - c.in).toFixed(3), '-i', c.path);
  const mono = c.ch === undefined ? '' : `pan=mono|c0=c${c.ch},`;
  chains.push(`[${k}:a:0]${mono}aformat=sample_rates=${sr}:channel_layouts=mono,adelay=${Math.round(c.start * 1000)}:all=1[a${k}]`);
});
const graph = chains.join(';') + ';' + clips.map((_, k) => `[a${k}]`).join('') +
  `amix=inputs=${clips.length}:duration=longest:normalize=0[out]`;
args.push('-filter_complex', graph, '-map', '[out]', '-c:a', 'pcm_s16le', out);
execFileSync('ffmpeg', args, { stdio: 'inherit' });
const end = Math.max(...clips.map(c => c.start + c.out - c.in));
console.error(`${clips.length} clips -> ${out}  (${end.toFixed(2)} s)`);
