#!/usr/bin/env node
// The graphics plan from the command line (format and rules: references/gfx-plan.md).
//   node scripts/gfxplan.mjs validate --plan <gfx-plan.json> [--edit <edit.json>]
//   node scripts/gfxplan.mjs preview --plan <gfx-plan.json> [--only LT_01,Q_02]
//   node scripts/gfxplan.mjs table --plan <gfx-plan.json>
// validate prints { ok, errors, warnings } and exits 1 when not ok. table prints the markdown
// table that goes to the chat for approval.
import { readFileSync } from 'node:fs';
import contract from './lib/gfx-contract.cjs';
import { planTable } from './lib/gfxcore.mjs';

const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : undefined; };
const read = (p) => JSON.parse(readFileSync(p, 'utf8'));
const cmd = process.argv[2];
if (!['validate', 'preview', 'table'].includes(cmd) || !arg('plan') ||
    (process.argv.includes('--only') && (cmd !== 'preview' || !arg('only')))) {
  console.error('usage: gfxplan.mjs validate|preview|table --plan <gfx-plan.json> [--edit <edit.json>] (preview also accepts --only A,B)');
  process.exit(2);
}
const planPath = arg('plan');
const plan = read(planPath);
if (cmd === 'table' && plan.style === 'cloudru' && !Object.hasOwn(plan, 'kit')) {
  console.log(planTable(plan));
} else {
  const report = contract.inspectPlan(plan, planPath, arg('edit') ? read(arg('edit')) : null);
  const result = cmd === 'preview' ? contract.selectMappings(report, arg('only')) : report;
  const { ok, errors, warnings } = result;
  if (cmd === 'table' && ok) console.log(planTable(plan, result.mappings));
  else console.log(JSON.stringify(cmd === 'preview' ? result : { ok, errors, warnings }, null, 2));
  process.exitCode = ok ? 0 : 1;
}
