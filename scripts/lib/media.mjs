// ffmpeg/ffprobe helpers shared by the graphics scripts. They shell out to the ffmpeg/ffprobe on
// PATH (8.x) and fail with ffmpeg's own words.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';

export function probeDuration(file) {
  return Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' }).trim());
}

// A render that outlived the bridge keeps writing: wait until the size holds still.
export async function waitStable(file, { everyMs = 2000, stableReads = 3, maxMs = 3600000 } = {}) {
  const t0 = Date.now();
  let last = -1, same = 0;
  while (Date.now() - t0 < maxMs) {
    const size = existsSync(file) ? statSync(file).size : -1;
    if (size > 0 && size === last) { if (++same >= stableReads) return size; } else same = 0;
    last = size;
    await new Promise((r) => setTimeout(r, everyMs));
  }
  throw new Error(`${file} did not settle within ${Math.round(maxMs / 1000)} s`);
}

// RMS level in dB of [a, b) seconds of the first audio stream, all channels together.
export function rmsDb(file, a, b) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-ss', a.toFixed(3), '-to', b.toFixed(3), '-i', file, '-vn',
    '-af', 'astats=measure_perchannel=none:measure_overall=RMS_level', '-f', 'null', '-'], { encoding: 'utf8' });
  const all = [...String(r.stderr).matchAll(/RMS level dB: (-?[\d.]+|-inf)/g)];
  if (!all.length) throw new Error(`no RMS for ${file} [${a}, ${b}): ${String(r.stderr).slice(-300)}`);
  const v = all[all.length - 1][1];
  return v === '-inf' ? -Infinity : Number(v);
}

// One PNG with the given frames tiled 4 across, in frame order.
export function frameSheet(file, frames, out, width = 480) {
  const uniq = [...new Set(frames)].sort((x, y) => x - y);
  const cols = Math.min(4, uniq.length), rows = Math.ceil(uniq.length / cols);
  const sel = uniq.map((f) => `eq(n\\,${f})`).join('+');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', file, '-vf', `select='${sel}',scale=${width}:-2,tile=${cols}x${rows}`,
    '-frames:v', '1', '-fps_mode', 'vfr', out]);
  return { out, frames: uniq };
}

// [r, g, b] of one pixel of one frame. Convert to rgb24 BEFORE the 1x1 crop: a 4:2:0 frame cannot be
// cropped to odd sizes ("Error reinitializing filters!").
export function pixelAt(file, frame, x, y) {
  const buf = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-vf', `select=eq(n\\,${frame}),format=rgb24,crop=1:1:${x}:${y}`,
    '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
  return [...buf.subarray(0, 3)];
}
