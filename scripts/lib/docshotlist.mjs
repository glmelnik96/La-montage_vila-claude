// Join a historical shots.json (first/last displayed frame centres in seconds)
// to independently computed map rows (half-open source and timeline intervals).
import { statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

function mediaKey(value) {
  if (typeof value !== 'string' || !value.trim() || /^\d+$/.test(value)) return '';
  const path = value.replaceAll('\\', '/');
  return /^(?:[a-z]:\/|\/\/)/i.test(path) ? path.toLowerCase() : path;
}

function pictureMatches(row, shot) {
  const path = mediaKey(shot.path);
  return Boolean(path && row.label && shot.label) && Number.isInteger(shot.tr) &&
    mediaKey(row.path) === path &&
    row.label === shot.label && row.track === shot.tr;
}

export function compareShotList(rows, reference, fd, listPath) {
  if (!Array.isArray(reference)) throw new Error('Expected a shots.json array');
  if (!(Number.isFinite(fd) && fd > 0)) throw new Error('Expected a positive frame duration');
  // seqdump serialises seconds to three decimal places.
  const tolerance = Math.min(fd / 10, 0.001) + 1e-8;
  const intervals = new Map();
  const joined = new Set();
  const encountered = new Set();
  for (const row of rows) {
    delete row.reference;
    const key = `${row.startFrame}/${row.endFrame}`;
    if (!intervals.has(key)) intervals.set(key, []);
    intervals.get(key).push(row);
  }

  const result = {
    referenceCount: reference.length, matched: 0, fullyMatched: 0,
    sourceMatched: 0, framesMatched: 0, differences: [],
  };
  // The historical numbered JPEGs were exported in timeline order. A list that
  // has since been reordered can still corroborate rows, but not JPEG indexes.
  const chronological = reference.every((shot, index) =>
    index === 0 || reference[index - 1]?.a < shot?.a);
  let previousStart = -Infinity;
  for (const [index, shot] of reference.entries()) {
    if (!shot || !Number.isFinite(shot.a) || !Number.isFinite(shot.b) || shot.b <= shot.a) {
      throw new Error(`Invalid timeline interval at shot list index ${index}`);
    }
    const startFrame = Math.round(shot.a / fd);
    const endFrame = Math.round(shot.b / fd);
    const interval = { referenceIndex: index, startFrame, endFrame };
    if (startFrame < previousStart) {
      result.differences.push({ ...interval, code: 'reference-out-of-order' });
    }
    previousStart = startFrame;
    const candidates = intervals.get(`${startFrame}/${endFrame}`) ?? [];
    if (Math.abs(shot.a - startFrame * fd) > tolerance || Math.abs(shot.b - endFrame * fd) > tolerance) {
      result.differences.push({ ...interval, code: 'off-grid-reference', seconds: [shot.a, shot.b] });
      continue;
    }
    if (!candidates.length) {
      const overlaps = rows.filter(row => row.startFrame < endFrame && row.endFrame > startFrame);
      result.differences.push({ ...interval, code: 'missing-range', overlappingRows: overlaps.map(r => r.id) });
      continue;
    }
    const identical = candidates.filter(row => pictureMatches(row, shot));
    if (identical.length !== 1) {
      candidates.forEach(row => encountered.add(row));
      result.differences.push({
        ...interval, code: identical.length ? 'ambiguous-picture' : 'picture-mismatch',
        expected: { path: shot.path, label: shot.label, track: shot.tr },
        candidates: candidates.map(({ id, path, label, track }) => ({ id, path, label, track })),
      });
      continue;
    }
    const row = identical[0];
    if (joined.has(row)) {
      result.differences.push({ ...interval, code: 'duplicate-reference', row: row.id });
      continue;
    }
    joined.add(row);
    result.matched++;
    const sourceRate = row.sourceRate === undefined ? 1 : row.sourceRate;
    const sourceKnown = !row.still && [shot.s0, shot.s1, row.sourceStart, row.sourceEnd, sourceRate].every(Number.isFinite) &&
      sourceRate > 0;
    const halfFrame = sourceRate * fd / 2;
    const mappedCenters = sourceKnown ? [row.sourceStart + halfFrame, row.sourceEnd - halfFrame] : null;
    const sourceMatches = sourceKnown &&
      Math.abs(shot.s0 - mappedCenters[0]) <= tolerance &&
      Math.abs(shot.s1 - mappedCenters[1]) <= tolerance;
    if (sourceMatches) result.sourceMatched++;
    else result.differences.push({
      ...interval, row: row.id, code: row.still ? 'still-no-time-axis' :
        sourceKnown ? 'source-mismatch' : 'source-unverified',
      referenceCentersSec: [shot.s0 ?? null, shot.s1 ?? null],
      mappedCentersSec: mappedCenters,
      mappedEdgesSec: [row.sourceStart ?? null, row.sourceEnd ?? null],
    });
    const kindMatches = Boolean(shot.kind) && shot.kind === row.kind;
    if (!kindMatches) result.differences.push({
      ...interval, row: row.id, code: 'kind-mismatch',
      expected: shot.kind ?? null, actual: row.kind ?? null,
    });
    if (sourceMatches && kindMatches) result.fullyMatched++;
    row.reference = { index, kind: shot.kind ?? null, frame: null, frameTimeVerified: false };
    if (listPath && chronological) {
      const jpg = resolve(dirname(listPath), `${String(index).padStart(3, '0')}.jpg`);
      if (statSync(jpg, { throwIfNoEntry: false })?.isFile()) {
        row.reference.frame = jpg;
        // The archived extractor requests the source midpoint. This verifies its
        // time against the snapshot, not the pixels, event or final composite.
        const samplingUncertain = row.issues?.some(issue =>
          issue === 'nested-frame-sampling-unverified' || issue === 'nested-frame-rate-missing' ||
          issue === 'source-timing-assumed');
        row.reference.frameTimeVerified = sourceMatches && !samplingUncertain;
        result.framesMatched++;
      }
    }
  }
  for (const row of rows) {
    if (!joined.has(row) && !encountered.has(row)) {
      result.differences.push({ code: 'extra-range', row: row.id, startFrame: row.startFrame, endFrame: row.endFrame });
    }
  }
  return result;
}
