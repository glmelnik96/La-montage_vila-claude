#!/usr/bin/env node
// Check a graphics pass as the viewer gets it (Workflow I, step 6): render the sequence through
// Premiere (the linked comps render through AE), put one frame per slot on a sheet, and compare the
// level under every overlay and logo slot with the plate's. A comp that carries audio shows up as
// +6 dB (references/after-effects-link.md). Inserts are not level-checked.
//
//   node scripts/gfxcheck.mjs --plan <film>_gfx/gfx-plan.json [--tol 0.5]
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { exportSequence } from './lib/prexport.mjs';
import { rmsDb, frameSheet } from './lib/media.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
if (!arg('plan')) { console.error('usage: gfxcheck.mjs --plan <gfx-plan.json> [--tol 0.5]'); process.exit(2); }
const PLAN = resolve(arg('plan')), DIR = dirname(PLAN), TOL = Number(arg('tol', 0.5));
const plan = JSON.parse(readFileSync(PLAN, 'utf8'));
const fps = plan.sequence.fps;
const live = plan.slots.filter((s) => !s.lost);
const frames = Math.max(plan.sequence.frames, ...live.map((s) => s.out));
const rendered = await exportSequence(plan.sequence.id, join(DIR, 'check.mov'), frames / fps, { withoutGfx: false, fps });
const out = rendered.out;
const sheet = frameSheet(out, live.map((s) => Math.round((s.in + s.out) / 2)), join(DIR, 'check_sheet.png'));
const levels = [];
for (const s of live.filter((x) => x.layer !== 'insert')) {
  const a = s.in / fps + 0.1, b = s.out / fps - 0.1;
  const check = rmsDb(out, a, b), plate = rmsDb(plan.plate, a, b);
  const silent = check === -Infinity && plate === -Infinity;
  levels.push({ id: s.id, check: silent ? null : +check.toFixed(2), plate: silent ? null : +plate.toFixed(2),
    diff: silent ? 0 : +(check - plate).toFixed(2), ok: silent || Math.abs(check - plate) <= TOL });
}
const report = { ok: levels.every((l) => l.ok), render: rendered, sheet: sheet.out, frames: sheet.frames, levels };
writeFileSync(join(DIR, 'check.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.ok ? 0 : 1;
