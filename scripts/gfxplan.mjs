#!/usr/bin/env node
// The graphics plan from the command line (format and rules: references/gfx-plan.md).
//   node scripts/gfxplan.mjs validate --plan <gfx-plan.json> [--edit <edit.json>]
//   node scripts/gfxplan.mjs table --plan <gfx-plan.json>
// validate prints { ok, errors, warnings } and exits 1 when not ok. table prints the markdown
// table that goes to the chat for approval.
import { readFileSync } from 'node:fs';
import { validatePlan, planTable } from './lib/gfxcore.mjs';

const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : undefined; };
const read = (p) => JSON.parse(readFileSync(p, 'utf8'));
const cmd = process.argv[2];
if (!['validate', 'table'].includes(cmd) || !arg('plan')) {
  console.error('usage: gfxplan.mjs validate|table --plan <gfx-plan.json> [--edit <edit.json>]');
  process.exit(2);
}
const plan = read(arg('plan'));
if (cmd === 'validate') {
  const r = validatePlan(plan, arg('edit') ? read(arg('edit')) : null);
  console.log(JSON.stringify(r, null, 2));
  process.exitCode = r.ok ? 0 : 1;
} else {
  console.log(planTable(plan));
}
