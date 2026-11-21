// Pure parts of the graphics pass: frame/tick math and plan validation (references/gfx-plan.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TYPES, secToFrames, framesToTicks, ticksToFrames, validatePlan } from '../lib/gfxcore.mjs';

const TPF25 = '10160640000';   // ticks per frame at 25 fps: 254016000000 / 25

function plan(slots, extra = {}) {
  return { version: 1, sequence: { id: 'seq-1', name: 'Film', fps: 25, w: 1920, h: 1080, frames: 450 },
    style: 'cloudru', plate: 'C:/film_gfx/plate.mov', aep: 'C:/film_gfx/film_gfx.aep', slots, ...extra };
}
const LT = { id: 'LT_01', type: 'lower_third', layer: 'overlay', in: 25, out: 125, text: { name: 'Иван Петров', role: 'CTO, Cloud.ru' } };
const errorsOf = (p, edit) => validatePlan(p, edit).errors.join('\n');

test('frames and ticks convert exactly', () => {
  assert.equal(secToFrames(6.5, 25), 163);                     // Premiere also lands a half frame on 163
  assert.equal(framesToTicks(25, TPF25), '254016000000');
  assert.equal(framesToTicks(180000, TPF25), '1828915200000000');
  assert.equal(framesToTicks(1, '8475667200'), '8475667200');   // 29.97 stays exact
  assert.equal(ticksToFrames('1656184320000', TPF25), 163);
  assert.equal(ticksToFrames('254016000001', TPF25), 25);
});

test('every type names its layer, its fields and a minimum', () => {
  for (const [name, t] of Object.entries(TYPES)) {
    assert.ok(['overlay', 'logo', 'insert'].includes(t.layer), name);
    assert.ok(Array.isArray(t.fields) && Array.isArray(t.optional), name);
    assert.ok(t.minSec > 0 && typeof t.label === 'string', name);
  }
});

test('a well-formed plan passes', () => {
  const r = validatePlan(plan([LT]));
  assert.deepEqual(r.errors, []);
  assert.equal(r.ok, true);
});

test('fractional frames are refused', () => {
  assert.match(errorsOf(plan([{ ...LT, in: 162.5 }])), /whole frames/);
});

test('slots on the same layer must not overlap; other layers may', () => {
  const second = { ...LT, id: 'LT_02', in: 100, out: 200 };
  assert.match(errorsOf(plan([LT, second])), /LT_01 and LT_02 overlap on the overlay layer/);
  const logo = { id: 'LOGO', type: 'logo', layer: 'logo', in: 0, out: 450, text: {} };
  assert.equal(validatePlan(plan([LT, logo])).ok, true);
});

test('text, type, layer, id, length and bounds are checked', () => {
  assert.match(errorsOf(plan([{ ...LT, text: { name: 'Иван Петров' } }])), /text\.role is required/);
  assert.match(errorsOf(plan([{ ...LT, type: 'banner' }])), /unknown type banner/);
  assert.match(errorsOf(plan([{ ...LT, layer: 'insert' }])), /layer must be overlay/);
  assert.match(errorsOf(plan([{ ...LT, id: 'lt/1' }])), /id must match/);
  assert.match(errorsOf(plan([{ ...LT, in: 25, out: 60 }])), /shorter than 75/);
  assert.match(errorsOf(plan([{ ...LT, in: 400, out: 500 }])), /out <= 450/);
  assert.match(errorsOf(plan([{ ...LT, text: { name: 'x'.repeat(41), role: 'CTO' } }])), /max 40/);
  assert.match(errorsOf(plan([{ ...LT, anchor: { kind: 'guess', text: 'x' } }])), /anchor\.kind/);
});

test('a plan made for another cut is refused', () => {
  const edit = { sequence: { id: 'seq-1', frames: 440 } };
  assert.match(errorsOf(plan([LT]), edit), /another cut/);
});

test('a lost slot is not checked against the new cut', () => {
  const lost = { ...LT, id: 'LT_09', in: 900, out: 1000, lost: true };
  assert.equal(validatePlan(plan([LT, lost])).ok, true);
});

import { planTable, norm, findAnchor, resyncSlots } from '../lib/gfxcore.mjs';

const W = (list) => list.map(([w, s]) => ({ w, s, e: s + 0.3, p: 0.99 }));
const WORDS = W([['Меня', 1.0], ['зовут', 1.2], ['Иван', 1.5], ['Петров.', 1.8], ['Облако', 5.0], ['—', 5.3], ['это', 5.4], ['сервис!', 5.6],
  ['Ещё', 30.0], ['раз:', 30.2], ['меня', 30.5], ['зовут', 30.7], ['Иван', 31.0], ['Петров', 31.2]]);

test('the chat table has one row per slot with time, label and text', () => {
  const t = planTable(plan([{ ...LT, why: 'первое появление' }]));
  const rows = t.split('\n');
  assert.equal(rows[0], '| # | Время | Тип | Текст | Почему |');
  assert.equal(rows[2], '| 1 | 0:01.0–0:05.0 | плашка | Иван Петров · CTO, Cloud.ru | первое появление |');
});

test('norm drops case, ё, punctuation and dashes', () => {
  assert.equal(norm('  Ёлка, «Привет» — ну-ка!  '), 'елка привет ну ка');
});

test('findAnchor finds every place a phrase is said, on word boundaries', () => {
  const hits = findAnchor(WORDS, 'меня зовут Иван Петров');
  assert.deepEqual(hits.map((h) => h.t), [1.0, 30.5]);
  assert.deepEqual(findAnchor(WORDS, 'облако это сервис').map((h) => h.t), [5.0]);   // the dash is not a word
  assert.deepEqual(findAnchor(WORDS, 'нет такой фразы'), []);
});

test('resyncSlots: words and markers re-anchor, time-anchored slots follow their clips, nothing is deleted', () => {
  const p = plan([
    { ...LT, in: 22, out: 122, anchor: { kind: 'words', text: 'меня зовут Иван Петров', offset: -3 } },
    { id: 'CH_01', type: 'chapter', layer: 'insert', in: 200, out: 260, text: { title: 'Глава 2' }, anchor: { kind: 'marker', text: 'Глава 2', offset: 0 } },
    { id: 'Q_01', type: 'quote', layer: 'overlay', in: 300, out: 400, text: { quote: 'x' }, anchor: { kind: 'words', text: 'этого больше нет' } },
    { id: 'LOGO', type: 'logo', layer: 'logo', in: 0, out: 450, text: {}, anchor: { kind: 'time' } },
    { id: 'CO_01', type: 'callout', layer: 'overlay', in: 215, out: 290, text: { value: '42%' }, anchor: { kind: 'time' } },
    { id: 'X_01', type: 'callout', layer: 'overlay', in: 150, out: 225, text: { value: '1' } },
  ]);
  // the new cut: 0.4 s removed before the name, the chapter marker moved to 190; the ripple split the
  // logo in two and moved the callout's clip
  const words = WORDS.map((w) => ({ ...w, s: w.s - 0.4 }));
  const edit = { sequence: { id: 'seq-1', name: 'Film', frames: 440 }, markers: [{ name: 'Глава 2', start: 190, end: 190 }],
    videoTracks: [{ index: 0, clips: [{ name: 'a.mp4', start: 0, end: 440 }] },
      { index: 2, clips: [{ name: 'CO_01/film_gfx.aep', start: 205, end: 280 }] },
      { index: 3, clips: [{ name: 'LOGO/film_gfx.aep', start: 0, end: 5 }, { name: 'LOGO/film_gfx.aep', start: 5, end: 440 }] }] };
  const r = resyncSlots(p, words, edit);
  const by = Object.fromEntries(r.plan.slots.map((s) => [s.id, s]));
  assert.deepEqual([by.LT_01.in, by.LT_01.out], [12, 112]);          // round(0.6 * 25) - 3; 100 frames kept
  assert.deepEqual([by.CH_01.in, by.CH_01.out], [190, 250]);
  assert.deepEqual([by.LOGO.in, by.LOGO.out], [0, 440]);             // re-joined over the span of its pieces
  assert.deepEqual([by.CO_01.in, by.CO_01.out], [205, 280]);
  assert.equal(by.Q_01.lost, true);
  assert.deepEqual(r.lost, ['Q_01']);
  assert.deepEqual(r.manual, ['X_01']);                              // no anchor, no clip: the user decides
  assert.deepEqual(r.moved.map((m) => m.id), ['LT_01', 'CH_01', 'LOGO', 'CO_01']);
  assert.equal(r.plan.sequence.frames, 440);
});

test('validatePlan warns when an edge sits within 0.5 s of a cut; an insert may sit on one', () => {
  const edit = { sequence: { id: 'seq-1', name: 'Film', frames: 300 }, markers: [],
    videoTracks: [{ index: 0, clips: [
      { name: 'a', media: 'C:/m/a.mp4', start: 0, end: 50, inPoint: 0 },
      { name: 'a', media: 'C:/m/a.mp4', start: 50, end: 100, inPoint: 50 },      // a through edit: no cut at 50
      { name: 'b', media: 'C:/m/b.mp4', start: 100, end: 200, inPoint: 0 },
      { name: 'c', media: 'C:/m/c.mp4', start: 200, end: 300, inPoint: 0 }] },
    { index: 1, clips: [{ name: 'LT_09/film_gfx.aep', media: 'C:/film_gfx/film_gfx.aep', start: 10, end: 20, inPoint: 0 }] }] };
  const p = plan([
    { id: 'IN_01', type: 'intro', layer: 'insert', in: 0, out: 88, text: { title: 'Фильм' } },
    { ...LT, in: 110, out: 190 },
    { id: 'CH_01', type: 'chapter', layer: 'insert', in: 200, out: 275, text: { title: 'Глава 2' } },
    { id: 'LOGO', type: 'logo', layer: 'logo', in: 0, out: 300, text: {} },
  ], { sequence: { id: 'seq-1', name: 'Film', fps: 25, w: 1920, h: 1080, frames: 300 } });
  const v = validatePlan(p, edit);
  assert.equal(v.ok, true, v.errors.join('; '));
  assert.deepEqual(v.warnings, [
    'slot IN_01: out 88 is 12 frames from the cut at 100; put it on the cut',
    'slot LT_01: in 110 is 10 frames from the cut at 100; keep 0.5 s clear',
    'slot LT_01: out 190 is 10 frames from the cut at 200; keep 0.5 s clear',
  ]);
  assert.deepEqual(validatePlan(p).warnings, []);      // without edit.json there are no cuts to check
});

test('resyncSlots takes the plate the new edit was rendered to (plate.b.mov while AE holds plate.mov)', () => {
  const edit = { sequence: { id: 'seq-1', name: 'Film', frames: 450 }, plate: 'C:\\film_gfx\\plate.b.mov', videoTracks: [] };
  assert.equal(resyncSlots(plan([{ ...LT, anchor: { kind: 'marker', text: 'none' } }]), [], edit).plan.plate, 'C:/film_gfx/plate.b.mov');
  assert.equal(resyncSlots(plan([LT]), [], { ...edit, plate: undefined }).plan.plate, 'C:/film_gfx/plate.mov');
});

import { pickTracks, placeRows } from '../lib/gfxcore.mjs';

test('pickTracks goes above everything the edit uses and ignores this pass\'s own clips', () => {
  const edit = { videoTracks: [
    { index: 0, clips: [{ name: 'a.mp4', media: 'D:/v/a.mp4' }] },
    { index: 1, clips: [{ name: 'slide.png', media: 'D:/v/slide.png' }] },
    { index: 2, clips: [{ name: 'LT_01/f_gfx.aep', media: 'C:\\f\\f_gfx.aep' }] },
    { index: 3, clips: [] }] };
  assert.deepEqual(pickTracks(edit, 'C:/f/f_gfx.aep'), { overlay: 2, logo: 3, insert: 4 });
  assert.deepEqual(pickTracks(edit, 'C:/f/f_gfx.aep', { tracks: { overlay: 5, logo: 6, insert: 7 } }), { overlay: 5, logo: 6, insert: 7 });
});

test('placeRows names the Premiere item <id>/<aep file> and skips lost slots', () => {
  const p = plan([LT, { ...LT, id: 'LT_02', in: 200, out: 300, lost: true }]);
  assert.deepEqual(placeRows(p, { overlay: 2, logo: 3, insert: 4 }), [{ id: 'LT_01', item: 'LT_01/film_gfx.aep', track: 2, inF: 25, outF: 125 }]);
});
