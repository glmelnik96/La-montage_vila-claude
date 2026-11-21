// The plan preview draws each slot in its own frames only (python + ffmpeg, synthetic plate).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pixelAt } from '../lib/media.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PY = process.env.PYTHON || 'python';

test('boxes appear in their frames and zones, inserts cover the frame', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gfxprev-'));
  const plate = join(dir, 'plate.mov');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=gray:s=1920x1080:r=25:d=4',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', plate]);
  const plan = { version: 1, sequence: { id: 'x', name: 'x', fps: 25, w: 1920, h: 1080, frames: 100 }, style: 'cloudru', plate, aep: join(dir, 'x_gfx.aep'),
    slots: [{ id: 'LT_01', type: 'lower_third', layer: 'overlay', in: 25, out: 75, text: { name: 'Иван Петров', role: 'CTO' } },
            { id: 'CH_01', type: 'chapter', layer: 'insert', in: 80, out: 100, text: { title: 'Глава 2' } }] };
  writeFileSync(join(dir, 'plan.json'), JSON.stringify(plan));
  const out = join(dir, 'preview.mp4'), sheet = join(dir, 'sheet.png');
  execFileSync(PY, [join(HERE, '..', 'gfxpreview.py'), '--plan', join(dir, 'plan.json'), '--out', out, '--sheet', sheet]);
  assert.ok(existsSync(out) && existsSync(sheet));
  // (520, 640) at 1280 px = (780, 960) at 1920: inside the lower-third zone, clear of its text
  const before = pixelAt(out, 10, 520, 640), during = pixelAt(out, 50, 520, 640), after = pixelAt(out, 77, 520, 640);
  assert.ok(during[0] < before[0] - 30, `the box darkens the plate: ${before} -> ${during}`);
  assert.ok(Math.abs(after[0] - before[0]) < 12, `the box is gone after out: ${after}`);
  const insert = pixelAt(out, 90, 640, 60);    // graphite 0x343F48 over the whole frame
  assert.ok(Math.abs(insert[0] - 0x34) < 20 && Math.abs(insert[2] - 0x48) < 20, `the insert covers the frame: ${insert}`);
});

test('boxes stack like the tracks (overlay, logo, insert on top), whatever the plan order', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gfxprev-'));
  const plate = join(dir, 'plate.mov');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=gray:s=1920x1080:r=25:d=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', plate]);
  const plan = { version: 1, sequence: { id: 'x', name: 'x', fps: 25, w: 1920, h: 1080, frames: 100 }, style: 'cloudru', plate, aep: join(dir, 'x_gfx.aep'),
    slots: [{ id: 'CH_01', type: 'chapter', layer: 'insert', in: 50, out: 100, text: { title: 'Глава 2' } },
            { id: 'LOGO', type: 'logo', layer: 'logo', in: 0, out: 100, text: {} }] };
  writeFileSync(join(dir, 'plan.json'), JSON.stringify(plan));
  const out = join(dir, 'preview.mp4');
  execFileSync(PY, [join(HERE, '..', 'gfxpreview.py'), '--plan', join(dir, 'plan.json'), '--out', out]);
  // (1215, 85) at 1280 px: inside the logo zone, clear of its label and border
  const logoOnly = pixelAt(out, 20, 1215, 85), underInsert = pixelAt(out, 75, 1215, 85);
  assert.ok(logoOnly[0] < 90, `the logo box darkens the plate: ${logoOnly}`);
  assert.ok(Math.abs(underInsert[0] - 0x34) < 20 && Math.abs(underInsert[2] - 0x48) < 20, `the insert covers the logo: ${underInsert}`);
});
