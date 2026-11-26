import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachNotes, brollUsage } from '../docmap.mjs';
import { prepareSnapshot } from '../lib/docsnapshot.mjs';
import { compareShotList } from '../lib/docshotlist.mjs';

test('a missing legacy Out uses the recorded sequence end including the tail', () => {
  const { startFrame, endFrame, limitations } = prepareSnapshot(
    {id:'s',name:'rolls',out:0,v:[],markers:[]}, 's',
    {seqs:[{id:'s',name:'rolls',fd:0.04,inP:-400000,outP:-400000,end:12,v:[]}]});
  assert.deepEqual([startFrame, endFrame], [0,300]);
  assert.ok(limitations.some(text => text.includes('Out')));
});

test('reference centres corroborate a correctly timed slow motion shot and flag a 1x annotation', () => {
  const row = {id:'F0',startFrame:0,endFrame:25,path:'a.mov',label:'take',track:1,kind:'broll',
    sourceStart:2,sourceEnd:2.5,sourceRate:0.5,issues:[]};
  const shot = {a:0,b:1,tr:1,path:'a.mov',label:'take',kind:'broll',s0:2.01,s1:2.49};
  assert.equal(compareShotList([row], [shot], 0.04).fullyMatched, 1);
  const check = compareShotList([row], [{...shot,s0:2.02,s1:2.98}], 0.04);
  assert.equal(check.matched, 1);
  assert.deepEqual(check.differences.map(d => d.code), ['source-mismatch']);
  assert.equal(row.reference.frameTimeVerified, false);
});

test('off-grid point stays on its displayed frame, a span joins both sides of a cut', () => {
  const rows = [{id:'a', startFrame:0, endFrame:1}, {id:'b', startFrame:1, endFrame:2}];
  const notes = [{id:'point', start:0.039, end:0.039}, {id:'span', start:0.039, end:0.041},
    {id:'at-out', start:0.08, end:0.08}];
  attachNotes(rows, notes, 0.04);
  assert.deepEqual(notes.map(n => n.rows), [['a'], ['a','b'], []]);
});

test('a replay, a partial overlap and adjacent excerpts from one file remain distinct', () => {
  const row = (id, sourceStart, sourceEnd, path = 'A:/media/one.mov') =>
    ({ id, kind: 'broll', path, sourceStart, sourceEnd });
  const ledger = brollUsage([row('a', 4, 6), row('b', 4, 6, 'a:\\MEDIA\\ONE.mov'),
    row('c', 6, 9), row('d', 5, 7), row('e', null, null), row('f', 4, 6, 'A:/other/one.mov')]);
  const pair = (a,b) => ledger.relations.find(r => r.rows[0] === a && r.rows[1] === b);
  assert.equal(ledger.sources.length, 2);
  assert.equal(pair('a','b').type, 'same-interval');
  assert.equal(pair('a','c').type, 'different-interval');
  assert.equal(pair('a','d').type, 'partial-overlap');
  assert.deepEqual(pair('a','d').overlap, [5, 6]);
  assert.equal(pair('a','e').type, 'unknown');
  assert.equal(pair('a','f'), undefined);
});

test('ordinary CLI maps a two-camera interview without B-roll at 30000/1001 fps', t => {
  const dir = mkdtempSync(join(tmpdir(), 'docmap-interview-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  const fd = 1001 / 30000;
  const clip = (name, a, b, offset) => [name, a*fd, b*fd, offset, offset + (b-a)*fd, name, name, 1, 0];
  const seq = { id: 'talk', name: 'Interview', fd, inP: fd*30, outP: fd*120, end: fd*150,
    v: [[clip('wide.mov', 0, 150, 45)], [clip('close.mov', 60, 90, 5)], [clip('title.png', 60, 75, 0)]],
    a: [[clip('speech.wav', 0, 150, 0)], [clip('music.wav', 55, 100, 0)]], vt: [[],[],[]],
    markers: [[60*fd,60*fd,'Cut to close-up','Check eyeline.']] };
  const snapshotPath = join(dir,'dump.json'), notesPath = join(dir,'notes.json'), out = join(dir,'map');
  writeFileSync(snapshotPath, JSON.stringify({seqs:[seq]}));
  writeFileSync(notesPath, JSON.stringify({sequenceId:'talk', entries:[{
    type:'quote', text:'This is the example.', source:'synthetic transcript',
    startFrame:55, endFrame:65, language:'en', speaker:'Guest',
  }]}));
  const cli = fileURLToPath(new URL('../docmap.mjs', import.meta.url));
  const args = [cli, '--snapshot', snapshotPath, '--sequence', 'talk', '--out', out,
    '--notes', notesPath, '--picture-tracks', '1-2', '--interview-tracks','1-2'];
  const run = () => spawnSync(process.execPath, args, {encoding:'utf8'});
  let result = run();
  assert.equal(result.status, 0, result.stderr);
  const map = JSON.parse(readFileSync(join(out,'map.json'), 'utf8'));
  assert.equal(map.sequence.fd, fd);
  assert.deepEqual(map.rows.map(r => [r.startFrame, r.endFrame, r.kind, r.path]), [
    [30,60,'interview','wide.mov'], [60,90,'interview','close.mov'], [90,120,'interview','wide.mov']]);
  assert.equal(map.usage.sources.length, 0);
  assert.deepEqual(map.notes.find(n => n.type === 'marker').rows, ['F60']);
  assert.deepEqual(map.notes.find(n => n.type === 'quote').rows, ['F30','F60']);
  assert.ok(readFileSync(join(out,'report.md'), 'utf8').includes('Check eyeline.'));
  writeFileSync(notesPath, JSON.stringify({sequenceId:'other-edit', entries:[]}));
  args[args.indexOf('--out') + 1] = join(dir,'other-map');
  result = run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /selected sequenceId/);
});
