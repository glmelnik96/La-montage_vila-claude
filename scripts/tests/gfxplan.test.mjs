// The plan CLI: validate exits 1 with the errors, table prints the chat table.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'gfxplan.mjs');
const base = { version: 1, sequence: { id: 's', name: 'F', fps: 25, w: 1920, h: 1080, frames: 450 }, style: 'cloudru',
  plate: 'C:/f/plate.mov', aep: 'C:/f/f_gfx.aep',
  slots: [{ id: 'LT_01', type: 'lower_third', layer: 'overlay', in: 25, out: 125, text: { name: 'Иван Петров', role: 'CTO' } }] };
function run(args, planObj) {
  const dir = mkdtempSync(join(tmpdir(), 'gfxplan-'));
  const p = join(dir, 'gfx-plan.json');
  writeFileSync(p, JSON.stringify(planObj));
  return spawnSync(process.execPath, [CLI, ...args, '--plan', p], { encoding: 'utf8' });
}

test('validate: ok plan exits 0', () => {
  const r = run(['validate'], base);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).ok, true);
});

test('validate: bad plan exits 1 and lists the errors', () => {
  const r = run(['validate'], { ...base, slots: [{ ...base.slots[0], in: 10.5 }] });
  assert.equal(r.status, 1);
  assert.match(JSON.parse(r.stdout).errors.join(' '), /whole frames/);
});

test('table prints the markdown table', () => {
  const r = run(['table'], base);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /\| 1 \| 0:01\.0–0:05\.0 \| плашка \| Иван Петров · CTO \|/);
});
