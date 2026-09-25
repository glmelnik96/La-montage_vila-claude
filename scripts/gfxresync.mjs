#!/usr/bin/env node
// After a re-edit, put the graphics back where they belong (Workflow I, «после перемонтажа»): hand the
// edit over again (plate.mov, edit.json, words.json), re-anchor every slot (gfxcore.resyncSlots), keep
// the old plan as gfx-plan.prev.json and write the new one. A slot whose anchor was cut is marked lost
// and reported, never deleted: the user decides.
//
//   node scripts/gfxresync.mjs --plan <film>_gfx/gfx-plan.json [--dry-run] [--lang ru] [--model large-v3] [--python <exe>]
//   node scripts/gfxresync.mjs --plan <film>_gfx/gfx-plan.json --apply
//
// --dry-run, or a result that does not validate (a cut through a slot left it too short, two slots now
// overlap), writes gfx-plan.resync.json and replaces nothing. Fix that file if needed, then --apply
// installs it against the edit.json already written, without rendering the plate again.
//
// Then rebuild (ae-motion-live: gfx-build.js --refresh-plate --no-capture), place, check. Place AFTER
// the build: a slot that grew needs the longer comp before its clip can run that long. The transcript
// is redone only when a slot is anchored to words.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resyncSlots, validatePlan } from './lib/gfxcore.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : undefined; };
if (!arg('plan')) { console.error('usage: gfxresync.mjs --plan <gfx-plan.json> [--dry-run | --apply] [--lang ru] [--model large-v3] [--python <exe>]'); process.exit(2); }
const PLAN = resolve(arg('plan')), DIR = dirname(PLAN), NEXT = join(DIR, 'gfx-plan.resync.json');
const read = (p) => JSON.parse(readFileSync(p, 'utf8'));
const NEXT_STEPS = ['gfx-build.js --plan <plan> --refresh-plate --no-capture (ae-motion-live)', 'gfxplace.mjs --plan <plan>', 'gfxcheck.mjs --plan <plan>'];
const install = (next) => { copyFileSync(PLAN, join(DIR, 'gfx-plan.prev.json')); writeFileSync(PLAN, JSON.stringify(next, null, 2)); };

if (process.argv.includes('--apply')) {
  if (!existsSync(NEXT)) { console.error(`no ${NEXT}: run gfxresync.mjs --dry-run first`); process.exit(2); }
  const next = read(NEXT), v = validatePlan(next, read(join(DIR, 'edit.json')));
  if (!v.ok) { console.log(JSON.stringify({ ok: false, replaced: false, valid: v }, null, 2)); process.exit(1); }
  install(next);
  console.log(JSON.stringify({ ok: true, replaced: true, from: NEXT, valid: v, next: NEXT_STEPS }, null, 2));
  process.exit(0);
}

const plan = read(PLAN);
const wordSlots = plan.slots.filter((s) => s.anchor && s.anchor.kind === 'words').map((s) => s.id);
const pass = ['lang', 'model', 'python'].flatMap((k) => (arg(k) ? [`--${k}`, arg(k)] : []));
// gfxexport's own output goes to stderr, so stdout carries this script's report only.
execFileSync(process.execPath, [join(HERE, 'gfxexport.mjs'), '--seq-id', plan.sequence.id, '--dir', DIR,
  ...(wordSlots.length ? pass : ['--no-words'])], { stdio: ['ignore', 2, 2] });
const edit = read(join(DIR, 'edit.json'));
const words = edit.words ? read(edit.words) : [];
const r = resyncSlots(plan, words, edit);
const v = validatePlan(r.plan, edit);
const report = { moved: r.moved, lost: r.lost, manual: r.manual, valid: v };
if (!v.ok || process.argv.includes('--dry-run')) {
  writeFileSync(NEXT, JSON.stringify(r.plan, null, 2));
  console.log(JSON.stringify({ ok: v.ok, replaced: false, wrote: NEXT, ...report,
    then: v.ok ? 'gfxresync.mjs --apply' : `fix ${NEXT} (errors above), then gfxresync.mjs --apply` }, null, 2));
  process.exit(v.ok ? 0 : 1);
}
install(r.plan);
console.log(JSON.stringify({ ok: true, replaced: true, ...report, next: NEXT_STEPS }, null, 2));
