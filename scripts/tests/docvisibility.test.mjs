import test from 'node:test';
import assert from 'node:assert/strict';
import { visibleRanges } from '../lib/docvisibility.mjs';

function clip(name, start, end, sourceIn, options = {}) {
  return { name, path: name, track: 0, start, end, sourceIn, sourceOut: sourceIn + end - start,
    speed: 1, reverse: false, ...options };
}
const sequence = (id, clips, options = {}) => ({ id, name: id, clips, ...options });

test('trimmed nested edit honours hidden tracks and disabled clips at each level, preserves overlay windows', () => {
  const inner = sequence('inner', [
    clip('first.mov', 0, 4, 12), clip('second.mov', 4, 8, 25),
    clip('hidden.mov', 0, 8, 80, { track: 3 }),
    clip('disabled.mov', 0, 8, 0, { track: 4, disabled: true }),
  ], { hiddenTracks: new Set([3]) });
  const root = sequence('main', [
    clip('under.mov', 0, 4, 8), clip('nest', 1, 4, 3, { track: 1, nest: inner.id }),
    clip('overlay.png', 1.4, 2.2, 0, { track: 2 }), clip('hidden.mov', 0, 4, 0, { track: 3 }),
  ], { hiddenTracks: new Set([3]), transitions: [{ track: 1, name: 'Dissolve', start: 2.5, end: 2.8 }] });
  const result = visibleRanges(new Map([[inner.id, inner]]), root, 0.1, 5, 40, c => c.track !== 2);
  assert.deepEqual(result.map(r => [r.startFrame, r.endFrame, r.path, r.sourceStart, r.sourceEnd]), [
    [5, 10, 'under.mov', 8.5, 9], [10, 20, 'first.mov', 15, 16], [20, 40, 'second.mov', 25, 27],
  ]);
  const windows = name => result.flatMap(r => r.issueRanges.filter(w => w.issue === name).map(w => [w.startFrame, w.endFrame]));
  assert.deepEqual(windows('excluded-overlay'), [[14, 20], [20, 22]]);
  assert.deepEqual(windows('transition'), [[25, 28]]);
});

test('adjacent placements merge only if picture is continuous; a restarted source is a separate use', () => {
  const root = sequence('main', [clip('a.mov', 0, 2, 1), clip('a.mov', 2, 4, 3), clip('a.mov', 4, 6, 1)]);
  const result = visibleRanges(new Map(), root, 0.04, 0, 150);
  assert.deepEqual(result.map(r => [r.startFrame, r.endFrame, r.sourceStart, r.sourceEnd]), [[0, 100, 1, 5], [100, 150, 1, 3]]);
  assert.deepEqual(result[0].placements.map(p => [p.startFrame, p.endFrame]), [[0, 50], [50, 100]]);
});

test('verified constant speed maps source time; mismatched bounds, ramps, reverse and stills get no invented intervals', () => {
  const root = sequence('main', [
    clip('slow.mov', 0, 2, 8, { sourceOut: 9, speed: 0.5 }),
    clip('unknown.mov', 2, 4, 11, { sourceOut: 12 }),
    clip('ramp.mov', 4, 6, 4, { hasRetime: true }),
    clip('reverse.mov', 6, 8, 0, { reverse: true }),
    clip('photo.jpg', 8, 10, 3599),
  ]);
  const result = visibleRanges(new Map(), root, 0.04, 25, 250);
  assert.deepEqual(result[0].sourceStart, 8.5);
  assert.deepEqual(result[0].sourceEnd, 9);
  assert.deepEqual(result.slice(1).map(r => [r.sourceStart, r.sourceEnd, r.issues[0]]), [
    [null, null, 'source-timing-unresolved'], [null, null, 'time-remapping-unresolved'],
    [null, null, 'reverse-source-unresolved'], [null, null, 'still-image'],
  ]);
});

test('cycles, missing sequences and picture gaps remain separate unresolved ranges', () => {
  const root = sequence('main', [clip('loop', 0, 1, 0, { nest: 'main' }), clip('missing', 2, 3, 0, { nest: 'absent' })]);
  const result = visibleRanges(new Map([[root.id, root]]), root, 0.04, 0, 75);
  assert.deepEqual(result.map(r => [r.startFrame, r.endFrame, r.path, r.issues[0]]), [
    [0, 25, null, 'nest-cycle'], [25, 50, null, 'picture-gap'], [50, 75, null, 'nest-missing'],
  ]);
});

test('a 1:1 span with no recorded speed or direction exposes its linear-time assumption', () => {
  const root = sequence('main', [clip('camera.mov', 0, 2, 10, {speed:null, reverse:null})]);
  const [row] = visibleRanges(new Map(), root, 0.04, 0, 25);
  assert.deepEqual([row.sourceStart, row.sourceEnd], [10, 11]);
  assert.ok(row.issues.includes('source-timing-assumed'));
});

test('missing or different nest frame rate leaves an explicit sampling warning', () => {
  const root = sequence('main', [clip('nest', 0, 1, 0, { nest: 'inner' })]);
  for (const [fd, expected] of [[null, 'nested-frame-rate-missing'], [1 / 30, 'nested-frame-sampling-unverified'], [0.04, null]]) {
    const inner = sequence('inner', [clip('a.mov', 0, 1, 8)], { fd });
    const [row] = visibleRanges(new Map([[inner.id, inner]]), root, 0.04, 0, 25);
    assert.deepEqual(row.issues, expected ? [expected] : []);
  }
});
