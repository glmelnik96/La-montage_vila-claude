// The plan CLI: validate exits 1 with the errors, table prints the chat table.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'gfxplan.mjs');
const base = { version: 1, sequence: { id: 's', name: 'F', fps: 25, w: 1920, h: 1080, frames: 450 }, style: 'cloudru',
  plate: 'C:/f/plate.mov', aep: 'C:/f/f_gfx.aep',
  slots: [{ id: 'LT_01', type: 'lower_third', layer: 'overlay', in: 25, out: 125, text: { name: 'Иван Петров', role: 'CTO' } }] };
function run(args, planObj, kit) {
  const dir = mkdtempSync(join(tmpdir(), 'gfxplan-'));
  const p = join(dir, 'gfx-plan.json');
  writeFileSync(p, JSON.stringify(planObj));
  if (kit) {
    const kitPath = join(dir, planObj.kit);
    mkdirSync(dirname(kitPath), { recursive: true });
    writeFileSync(kitPath, JSON.stringify(kit));
  }
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

const kit = {
  version: 1, style: 'portrait', roles: {
    label: { template: 'Portrait label', layer: 'overlay', fields: {
      name: { target: 'headline', required: true }, role: { target: 'byline', required: false },
    } },
  },
};
const chapterLabel = { id: 'CH_02', type: 'chapter', layer: 'overlay', visualRole: 'label',
  in: 175, out: 300, text: { name: 'Эпилог' } };
const client = { ...base, style: 'portrait', kit: 'kits/portrait.json',
  slots: [{ ...base.slots[0], visualRole: 'label' }, chapterLabel] };

test('offline preview and table map an editorial chapter to a client nameplate', () => {
  const r = run(['preview', '--only', 'CH_02'], client, kit);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const { ok, mappings } = JSON.parse(r.stdout);
  assert.equal(ok, true);
  assert.equal(mappings.length, 1);
  const [row] = mappings;
  assert.equal(row.id, chapterLabel.id);
  assert.equal(row.type, 'chapter');
  assert.equal(row.layer, 'overlay');
  assert.equal(row.visualRole, 'label');
  assert.equal(row.template, 'Portrait label');
  assert.deepEqual(row.fields, [
    { key: 'name', target: 'headline', required: true, value: 'Эпилог' },
    { key: 'role', target: 'byline', required: false, value: '' },
  ]);
  const table = run(['table'], client, kit);
  assert.equal(table.status, 0, table.stderr + table.stdout);
  for (const term of ['CH_02', 'Portrait label', 'TXT_HEADLINE', 'Эпилог']) assert.ok(table.stdout.includes(term), term);
});

test('preview rejects an unknown slot even when the rest of the kit passes', () => {
  const r = run(['preview', '--only', 'NO_SUCH'], client, kit);
  assert.equal(r.status, 1);
  assert.match(JSON.parse(r.stdout).errors.join(' '), /NO_SUCH/);
});

test('a product video can map its own value and unit fields to a feature callout', () => {
  const role = { template: 'Feature annotation', layer: 'overlay', fields: {
    metric: { target: 'stat', required: true }, unit: { target: 'suffix', required: true },
  } };
  const product = { version: 1, style: 'product', roles: { feature_stat: role } };
  const plan = { ...base, style: 'product', kit: 'kits/product.json', slots: [{ id: 'FT_01', type: 'callout', layer: 'overlay',
    visualRole: 'feature_stat', in: 25, out: 125, text: { metric: '120', unit: 'Гц' } }] };
  const preview = run(['preview'], plan, product);
  assert.equal(preview.status, 0, preview.stdout + preview.stderr);
  const [row] = JSON.parse(preview.stdout).mappings;
  assert.equal(row.template, 'Feature annotation');
  assert.deepEqual(row.fields.map(f => [f.key, f.target, f.value]), [['metric', 'stat', '120'], ['unit', 'suffix', 'Гц']]);
});

test('client validate and preview report the same invalid mappings', () => {
  for (const [fields, term] of [[{ visualRole: 'unmapped' }, 'unmapped'], [{ text: {} }, 'name']]) {
    const plan = { ...client, slots: [{ ...chapterLabel, ...fields }] };
    const validated = run(['validate'], plan, kit), preview = run(['preview'], plan, kit);
    assert.equal(validated.status, 1);
    assert.equal(preview.status, 1);
    const errors = JSON.parse(validated.stdout).errors;
    assert.ok(errors.join(' ').includes(term));
    assert.deepEqual(errors, JSON.parse(preview.stdout).errors);
  }
});

test('placement and resync --apply resolve the kit next to the plan', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gfxapply-'));
  const path = join(dir, 'gfx-plan.json');
  const next = join(dir, 'gfx-plan.resync.json');
  const plan = { ...client, kit: 'kit.json', aep: join(dir, 'absent.aep') };
  const invalid = { ...plan, slots: [{ ...chapterLabel, text: {} }] };
  const runStep = (script, ...args) => spawnSync(process.execPath,
    [join(dirname(CLI), script), '--plan', path, ...args], { encoding: 'utf8' });
  writeFileSync(join(dir, 'kit.json'), JSON.stringify(kit));
  writeFileSync(join(dir, 'edit.json'), JSON.stringify({ sequence: base.sequence }));
  writeFileSync(path, JSON.stringify(invalid));
  const place = runStep('gfxplace.mjs');
  assert.equal(place.status, 1, place.stderr);
  assert.ok(JSON.parse(place.stdout).errors.some(e => e.includes('name')));

  writeFileSync(path, JSON.stringify(plan));
  writeFileSync(next, JSON.stringify(invalid));
  const rejected = runStep('gfxresync.mjs', '--apply');
  assert.equal(rejected.status, 1, rejected.stderr);
  assert.equal(JSON.parse(rejected.stdout).replaced, false);
  assert.deepEqual(JSON.parse(readFileSync(path)), plan);
  const revised = { ...plan, slots: [{ ...chapterLabel, in: 155 }] };
  writeFileSync(next, JSON.stringify(revised));
  const applied = runStep('gfxresync.mjs', '--apply');
  assert.equal(applied.status, 0, applied.stderr + applied.stdout);
  assert.deepEqual(JSON.parse(readFileSync(path)), revised);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'gfx-plan.prev.json'))), plan);
});
