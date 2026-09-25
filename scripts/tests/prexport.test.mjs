// Where a render goes when the old file is still held open (prexport.freePath).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freePath } from '../lib/prexport.mjs';

const busy = (locked) => (from, to) => {
  if (locked.includes(from)) { const e = new Error(`EBUSY: ${from}`); e.code = 'EBUSY'; throw e; }
  renameSync(from, to);
};

test('freePath keeps an old render as .prev and reuses the name', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prexport-'));
  const out = join(dir, 'plate.mov');
  assert.equal(freePath(out), out);                       // nothing there yet
  writeFileSync(out, 'old');
  assert.equal(freePath(out), out);
  assert.ok(existsSync(join(dir, 'plate.prev.mov')) && !existsSync(out));
});

test('freePath falls back to the other name of the pair while the file is locked, and fails when both are', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prexport-'));
  const out = join(dir, 'plate.mov'), alt = join(dir, 'plate.b.mov');
  writeFileSync(out, 'held by AE');
  assert.equal(freePath(out, busy([out])), alt);
  writeFileSync(alt, 'held too');
  assert.equal(freePath(out, busy([alt])), out);         // AE moved on to plate.b.mov: plate.mov is free again
  writeFileSync(out, 'held again');
  assert.throws(() => freePath(out, busy([out, alt])), /both in use/);
  const other = (from) => { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; };
  assert.throws(() => freePath(out, other), /ENOENT/);   // only a lock falls back
});
