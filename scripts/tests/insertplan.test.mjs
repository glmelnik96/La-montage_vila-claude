// Planning of rippleinsert.mjs: gaps opened on every track at once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planInserts } from '../lib/insertplan.mjs';

const v = (id, tr, st, en, still = 0) => ({ id, k: 'v', tr, st, en, still, name: id });
const a = (id, tr, st, en) => ({ id, k: 'a', tr, st, en, still: 0, name: id });

test('items after a gap move by the sum of the gaps at or before their start', () => {
  const p = planInserts([v('x', 0, 10, 20), v('y', 0, 20, 30), v('z', 0, 40, 50)], [], [{ at: 20, d: 2 }, { at: 35, d: 1 }]);
  assert.deepEqual(p.moves.map((m) => [m.id, m.tg]), [['z', 43], ['y', 22]]);   // descending start
  assert.equal(p.total, 3);
  assert.deepEqual(p.crossing, []);
});

test('a still or adjustment layer across a gap grows instead of moving', () => {
  const p = planInserts([v('lut', 4, 0, 100, 1)], [], [{ at: 20, d: 2.48 }, { at: 50, d: 0.96 }]);
  assert.deepEqual(p.moves, []);
  assert.deepEqual(p.grows.map((g) => [g.id, g.st, g.en, g.tgEn, g.media]), [['lut', 0, 100, 103.44, false]]);
});

test('music on an extend track grows through the gap, also when it starts exactly on it', () => {
  const p = planInserts([a('m1', 3, 0, 124.08), a('m2', 3, 128.08, 235.68), a('m3', 6, 479.76, 806.73)], [],
    [{ at: 23.52, d: 2.48 }, { at: 54.48, d: 2.48 }, { at: 128.08, d: 2.48 }, { at: 168.72, d: 2.48 }], { extend: ['A4', 'A7'] });
  const g = Object.fromEntries(p.grows.map((x) => [x.id, x]));
  assert.equal(g.m1.st, 0); assert.equal(g.m1.tgEn, 129.04);
  assert.equal(g.m2.st, 133.04); assert.equal(g.m2.tgEn, 245.6);        // moved by the two gaps before, grown by two
  assert.deepEqual(p.moves.map((m) => [m.id, m.tg]), [['m3', 489.68], ['m2', 133.04]]);
});

test('a clip across a gap on an ordinary track is refused', () => {
  const p = planInserts([v('take', 0, 10, 30)], [], [{ at: 20, d: 1 }]);
  assert.equal(p.crossing.length, 1);
  assert.deepEqual(p.crossing[0].at, [20]);
});

test('a clip that ends exactly on the gap stays, one that starts on it moves', () => {
  const p = planInserts([v('a', 0, 10, 20), v('b', 0, 20, 30)], [], [{ at: 20, d: 1 }]);
  assert.deepEqual(p.moves.map((m) => m.id), ['b']);
  assert.deepEqual(p.crossing, []);
});

test('markers and the In/Out follow', () => {
  const p = planInserts([], [{ guid: 'g1', st: 5, en: 5, name: 'm' }, { guid: 'g2', st: 25, en: 25, name: 'n' }],
    [{ at: 20, d: 2 }], { inP: 0, outP: 100 });
  assert.deepEqual(p.marks.map((m) => [m.guid, m.tg]), [['g2', 27]]);
  assert.equal(p.inTg, 0); assert.equal(p.outTg, 102);
});

test('an unset In/Out (-400000) stays unset', () => {
  const p = planInserts([], [], [{ at: 20, d: 2 }], { inP: -400000, outP: -400000 });
  assert.equal(p.inTg, -400000); assert.equal(p.outTg, -400000);
});

test('transitions move with their clips; one across a gap is refused', () => {
  const tr = [{ k: 'a', tr: 1, st: 389.68, en: 390.8, name: 'Custom Fade' }, { k: 'a', tr: 0, st: 53.04, en: 53.76, name: 'Constant Power' },
    { k: 'v', tr: 7, st: 0, en: 1.2, name: 'Cross Dissolve' }];
  const p = planInserts([], [], [{ at: 23.52, d: 2.48 }, { at: 308.8, d: 2.48 }], { transitions: tr });
  assert.deepEqual(p.tmoves.map((m) => [m.label, m.tg]), [['A2', 394.64], ['A1', 55.52]]);
  const q = planInserts([], [], [{ at: 0.6, d: 1 }], { transitions: tr });
  assert.equal(q.crossing.length, 1);
  assert.equal(q.crossing[0].transition, true);
});

test('the head fade of music that grows from a gap stays with it', () => {
  const p = planInserts([a('m', 3, 128.08, 235.68)], [], [{ at: 23.52, d: 2.48 }, { at: 128.08, d: 2.48 }],
    { extend: ['A4'], transitions: [{ k: 'a', tr: 3, st: 128.08, en: 129.6, name: 'Constant Power' }] });
  assert.deepEqual(p.tmoves.map((m) => m.tg), [130.56]);                       // moved by 23.52's gap only, like the clip
  assert.equal(p.grows[0].st, 130.56);
});
