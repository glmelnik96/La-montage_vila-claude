// ffmpeg/ffprobe helpers, on files synthesized here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeDuration, waitStable, rmsDb, frameSheet, pixelAt } from '../lib/media.mjs';

const dir = mkdtempSync(join(tmpdir(), 'media-'));
const clip = join(dir, 'clip.mov');
// 2 s of grey picture; audio: 1 s of a tone, then 1 s of the same tone twice as loud
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=gray:s=320x180:r=25:d=2',
  '-f', 'lavfi', '-i', "sine=frequency=440:sample_rate=48000:duration=2,volume='if(lt(t,1),0.25,0.5)':eval=frame",
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'pcm_s16le', '-shortest', clip]);

test('probeDuration reads the container length', () => {
  assert.ok(Math.abs(probeDuration(clip) - 2) < 0.05);
});

test('waitStable returns once the size holds still', async () => {
  const size = await waitStable(clip, { everyMs: 20, stableReads: 2, maxMs: 2000 });
  assert.ok(size > 0);
});

test('rmsDb measures a range: doubling the amplitude is +6 dB', () => {
  const a = rmsDb(clip, 0.1, 0.9), b = rmsDb(clip, 1.1, 1.9);
  assert.ok(Math.abs((b - a) - 6.02) < 0.3, `${a} -> ${b}`);
});

test('frameSheet tiles the chosen frames and pixelAt reads one pixel', () => {
  const out = join(dir, 'sheet.png');
  frameSheet(clip, [10, 30], out, 160);
  assert.ok(existsSync(out));
  const px = pixelAt(clip, 10, 5, 5);
  assert.equal(px.length, 3);
  assert.ok(Math.abs(px[0] - 128) < 12, `grey: ${px}`);
});
