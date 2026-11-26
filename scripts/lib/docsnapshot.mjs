// Readers for the saved project XML inventory (flat items) and seqdump (per-track tuples).
// All internal media coordinates are seconds in the source, all tracks are zero-based.
const TICKS_PER_SECOND = 254016000000;
const finite = Number.isFinite;
const flag = value => value === true || value === 1;
const close = (a, b) => finite(a) && finite(b) && Math.abs(a - b) <= 0.00101;

function sequenceFrameDuration(record, companion, project) {
  const values = [record, companion, project].filter(Boolean)
    .flatMap(s => [s.fd, s.fps == null ? null : 1 / s.fps]).filter(v => v != null);
  if (values.some(v => !finite(v) || v <= 0)) throw new Error('Invalid frame duration in ' + record.name);
  // Some named-track dumps round fps to three decimal places.
  if (values.some(v => Math.abs(values[0] - v) > 1e-7)) {
    throw new Error('Sequence frame durations differ between snapshots: ' + record.name);
  }
  return record.fd ?? companion?.fd ?? project?.fd ?? values[0] ?? null;
}

function records(snapshot) {
  const rows = snapshot?.seqs ?? (snapshot?.v ? [snapshot] : Object.values(snapshot ?? {}));
  if (!Array.isArray(rows) || !rows.length || rows.some(r => !r?.id || typeof r.name !== 'string')) {
    throw new Error('Expected a sequence inventory or a seqdump with sequence IDs and names');
  }
  if (new Set(rows.map(r => r.id)).size !== rows.length) throw new Error('Duplicate sequence IDs');
  return rows;
}

function select(rows, selector) {
  if (selector) {
    const byId = rows.find(s => s.id === selector);
    if (byId) return byId;
    const matches = rows.filter(s => s.name === selector);
    if (matches.length === 1) return matches[0];
    throw new Error(matches.length ? 'Ambiguous sequence name; select by ID' : 'Sequence not found: ' + selector);
  }
  const detailed = rows.filter(s => Array.isArray(s.v));
  if (detailed.length === 1) return detailed[0];
  throw new Error('Select a sequence by ID or exact, unique name');
}

function trackMutes(record) {
  const states = new Map();
  for (const [track, item] of (record.v ?? []).entries()) {
    if (item.mute != null && Array.isArray(item.clips)) states.set(track, flag(item.mute));
  }
  if (Array.isArray(record.muted)) {
    for (const [kind, track, value] of record.muted) {
      if (kind === 0) states.set(track, flag(value));
    }
  } else {
    for (const [key, value] of Object.entries(record.muted ?? {})) {
      if (/^v\d+$/.test(key)) states.set(Number(key.slice(1)), flag(value));
    }
  }
  return states;
}

function readClips(record) {
  const clips = [];
  function add(clip) {
    if (!Number.isInteger(clip.track) || clip.track < 0 || !finite(clip.start) ||
        !finite(clip.end) || clip.end <= clip.start) {
      throw new Error('Invalid video item bounds or track: ' + record.name + ' / ' + clip.name);
    }
    clip.issues = [];
    clip.id = String(clip.id ?? (clip.track + '-' + clips.length));
    clips.push(clip);
  }
  for (const [index, item] of record.v.entries()) {
    const namedTrack = Array.isArray(item.clips);
    if (!Array.isArray(item) && !namedTrack) {
      const effects = item.effects ?? [];
      const reverse = item.reverse == null ? null : flag(item.reverse);
      add({
        id: item.oid, track: item.tr, name: item.name, start: item.st, end: item.en,
        sourceIn: reverse ? null : item.inP ?? null, sourceOut: reverse ? null : item.outP ?? null,
        path: item.path || '',
        nest: item.nest || null, disabled: item.dis ?? null, hidden: item.hidden ?? null,
        speed: item.speed ?? null, reverse, effects,
        hasRetime: flag(item.hasRetime) || effects.some(f => /time[ _-]*remap/i.test(f.match ?? f.name ?? '')),
      });
      continue;
    }
    for (const tuple of namedTrack ? item.clips : item) {
      if (!Array.isArray(tuple) || (namedTrack ? tuple.length !== 8 : tuple.length < 7 || tuple.length > 9)) {
        throw new Error('Unknown video item tuple format in ' + record.name);
      }
      const [name, start, end, input, output, path, node] = tuple;
      // Named tracks store linked item count at [6]. The 8-field preservation
      // dump on unnamed tracks stores a project item ID there. Neither is an occurrence ID.
      // seqdump stores a *track* item ID, speed and reverse (9 fields).
      if (tuple.length === 8 && !namedTrack && !Array.isArray(record.muted)) {
        throw new Error('Ambiguous 8-field video tuple without preservation dump track metadata');
      }
      const speed = tuple.length === 9 ? tuple[7] : null;
      const reverse = tuple.length === 9 ? flag(tuple[8]) : null;
      const sourceTime = t => finite(t) && !reverse ? t * (speed ?? 1) : null;
      add({
        id: tuple.length === 8 ? null : node,
        name, track: index, start, end, sourceIn: sourceTime(input), sourceOut: sourceTime(output),
        path: path || '', nest: null, disabled: tuple.length === 8 ? flag(tuple[7]) : null,
        hidden: null, speed, reverse, effects: [], hasRetime: false,
      });
    }
  }
  return clips;
}

function transitions(record) {
  return (record.vt ?? []).flatMap((items, track) =>
    items.map(([start, end, name]) => ({track, start, end, name})));
}

function readMarkers(record) {
  if (typeof record.markers === 'number') return []; // count-only dump
  return (record.markers ?? []).map((m, i) => {
    let start, end, name, comment;
    if (Array.isArray(m)) {
      if (typeof m[0] === 'number') [start, end, name, comment] = m;
      else [name, comment, start, end] = m;
    } else {
      start = Number(m.mStartTime?.ticks) / TICKS_PER_SECOND;
      end = m.mEndTime ? Number(m.mEndTime.ticks) / TICKS_PER_SECOND :
        start + Number(m.mDuration?.ticks ?? 0) / TICKS_PER_SECOND;
      name = m.mName;
      comment = m.mComment;
    }
    if (!finite(start) || !finite(end) || end < start) throw new Error('Invalid marker interval in ' + record.name);
    return {id: m.mMarkerID ?? record.id + ':marker:' + i, start, end, name: name ?? '', comment: comment ?? ''};
  });
}

function checkMetadata(record, other) {
  if (record.name !== other.name) throw new Error('Sequence name differs between snapshots for ID ' + record.id);
  for (const [a, b] of [[record.inP, other.inP], [record.outP ?? record.out, other.outP ?? other.out]]) {
    if (finite(a) && finite(b) && Math.max(a, b) > 0 && !close(a, b)) {
      throw new Error('Sequence In/Out differs between snapshots: ' + record.name);
    }
  }
}

// Compare the item multiset before accepting metadata from a companion capture.
// An empty CEP media path is normal for a generated item with numeric XML media ID.
function matchClips(primary, companion, name) {
  const key = c => JSON.stringify([c.track, c.name, Math.round(c.start * 1000),
    Math.round(c.end * 1000), /^\d+$/.test(c.path) ? '' : c.path.replaceAll('\\', '/')]);
  const byKey = Map.groupBy(companion, key);
  for (const c of primary) {
    const options = byKey.get(key(c)) ?? [];
    const matches = options.filter(o => ['sourceIn', 'sourceOut'].every(k =>
      c[k] === null || o[k] === null || close(c[k], o[k])) &&
      ['speed', 'reverse', 'disabled'].every(k => c[k] == null || o[k] == null || c[k] === o[k]));
    if (matches.length !== 1) {
      throw new Error('Companion video item differs or is ambiguous: ' + name + ' / V' +
        (c.track + 1) + ' @ ' + c.start + ' / ' + c.name);
    }
    const peer = matches[0];
    options.splice(options.indexOf(peer), 1);
    c.disabled ??= peer.disabled;
    c.speed ??= peer.speed;
    c.reverse ??= peer.reverse;
    if (c.reverse) c.sourceIn = c.sourceOut = null;
  }
  if (primary.length !== companion.length) throw new Error('Video item count differs between snapshots: ' + name);
}

// The XML companion uses the same IDs, media coordinates and clip bounds as
// the flat inventory. Validate every occurrence before trusting its rate or mute.
function mergeProject(record, clips, evidence, coverage) {
  const problem = message => new Error('Project evidence ' + message + ': ' + record.name);
  if (record.v.some(item => Array.isArray(item) || Array.isArray(item.clips))) {
    throw problem('requires a flat XML inventory');
  }
  if (evidence?.name !== record.name || !Array.isArray(evidence.clips) || evidence.clips.length !== clips.length) {
    throw problem('missing or incompatible');
  }
  const identity = (track, name, path, nest) => JSON.stringify([track, name, path || '', nest || '']);
  const groups = Map.groupBy(evidence.clips, c => identity(c.track, c.name, c.path, c.nest));
  for (const [index, c] of clips.entries()) {
    const raw = record.v[index];
    const group = groups.get(identity(c.track, c.name, c.path, c.nest)) ?? [];
    const matches = group.filter(e => close(c.start, e.start) && close(c.end, e.end) &&
      close(raw.inP, e.sourceIn) && close(raw.outP, e.sourceOut));
    if (matches.length !== 1) throw problem('item missing or ambiguous at ' + c.start + ' on V' + (c.track + 1));
    const e = matches[0];
    group.splice(group.indexOf(e), 1);
    for (const field of ['speed', 'reverse']) {
      if (e[field] == null) continue;
      if (c[field] != null && c[field] !== e[field]) throw problem(field + ' differs at ' + c.start);
      if (field === 'speed' && c.speed == null) coverage.speeds++;
      c[field] = e[field];
    }
    if (e.disabled === true && !c.disabled) coverage.disabled++;
    if (e.disabled != null) c.disabled = Boolean(c.disabled) || e.disabled;
    if (e.hasRetime != null) c.hasRetime = Boolean(c.hasRetime) || e.hasRetime;
    if (c.reverse) c.sourceIn = c.sourceOut = null;
  }
  coverage.sequences++;
  coverage.clips += clips.length;
}

export function prepareSnapshot(snapshot, selector, metadata, projectEvidence) {
  const rows = records(snapshot);
  const selected = select(rows, selector || snapshot.active);
  if (!Array.isArray(selected.v)) throw new Error('Selected sequence has no video track dump: ' + selected.name);
  const peers = new Map((metadata ? records(metadata) : []).map(s => [s.id, s]));
  const peer = peers.get(selected.id);
  if (metadata && !peer) throw new Error('Companion snapshot lacks selected sequence ID: ' + selected.id);
  if (snapshot.project && metadata?.project && snapshot.project !== metadata.project) {
    throw new Error('Snapshots belong to different projects');
  }
  const limitations = new Set();
  let start = selected.inP ?? peer?.inP;
  let end = selected.out ?? selected.outP ?? peer?.outP;
  if (!finite(start) || start < 0) {
    start = 0;
    limitations.add('In не записан или не установлен. Карта начинается с нуля.');
  }
  // The flat XML inventory serialised an absent MZ.OutPoint as zero.
  if (end == null || end < 0 || (selected.out === 0 && (peer?.outP ?? 0) <= 0)) {
    end = selected.end ?? peer?.end;
    limitations.add('Out не установлен. Использован записанный конец секвенции.');
  }
  if (!finite(end) || !(end > start)) throw new Error('Active edit range is missing or empty');
  const byId = new Map(rows.map(r => [r.id, r]));
  const byName = Map.groupBy(rows, r => r.name);
  const sequences = new Map();
  const coverage = {sequences: 0, clips: 0, speeds: 0, disabled: 0};
  function visit(record) {
    if (sequences.has(record.id) || !Array.isArray(record.v)) return;
    const other = peers.get(record.id);
    if (other) checkMetadata(record, other);
    const clips = readClips(record);
    if (Array.isArray(other?.v)) matchClips(clips, readClips(other), record.name);
    const project = projectEvidence?.sequences?.[record.id];
    if (projectEvidence) mergeProject(record, clips, project, coverage);
    const mutes = trackMutes(other ?? {});
    for (const [t, state] of trackMutes(record)) mutes.set(t, state);
    const hiddenTracks = new Set([...mutes].filter(([, muted]) => muted).map(([t]) => t));
    const seq = {
      id: record.id, name: record.name, clips, hiddenTracks, fd: sequenceFrameDuration(record, other, project),
      transitions: transitions(record.vt ? record : other ?? record),
    };
    sequences.set(record.id, seq);
    if (record !== selected && seq.fd == null) {
      limitations.add('Частота кадров части вложений не записана. Покадровое соответствие с родительской секвенцией не подтверждено.');
    }
    if (!record.vt && !other?.vt) limitations.add('Для части дорожек отсутствуют сведения о переходах.');
    for (const c of clips) {
      if (!mutes.has(c.track)) limitations.add('Для части видеодорожек снимок не содержит состояния видимости.');
      if (c.disabled == null) limitations.add('Состояние отключения части клипов не записано.');
      if (c.speed == null || c.reverse == null) limitations.add('Для части клипов скорость и реверс не записаны.');
      // Only tuple dumps lack an explicit nest link. A same-name generated clip can
      // be a false match, so surface this inference even when the target is unique.
      if (!c.path && !c.nest && Array.isArray(record.v[0])) {
        const targets = byName.get(c.name) ?? [];
        if (targets.length === 1) {
          c.nest = targets[0].id;
          c.issues.push('nested-id-inferred-from-name');
        } else if (targets.length > 1) c.issues.push('ambiguous-nested-sequence-name');
      }
      if (c.nest && byId.has(c.nest)) visit(byId.get(c.nest));
    }
  }
  visit(selected);
  const root = sequences.get(selected.id);
  const fd = root.fd;
  if (fd == null) throw new Error('Frame duration fd missing; supply a matching seqdump or saved project');
  const startFrame = Math.round(start / fd), endFrame = Math.round(end / fd);
  if (endFrame <= startFrame) throw new Error('Active edit range contains no frames');
  if (projectEvidence) {
    limitations.add('Сверка с XML проекта по ID секвенции и параметрам клипов. Проверено секвенций: ' +
      coverage.sequences + ', видеоэлементов: ' + coverage.clips +
      '. Дополнено значений скорости: ' + coverage.speeds + ', отключённых клипов: ' + coverage.disabled + '.');
  }
  const markerRecord = Array.isArray(selected.markers) || !Array.isArray(peer?.markers) ? selected : peer;
  if (typeof markerRecord.markers === 'number' && markerRecord.markers > 0) {
    limitations.add('Сохранено только количество маркеров (' + markerRecord.markers + '), без координат и текста.');
  }
  limitations.add('Снимки не содержат полного композитинга, геометрии масок и ключей Time Remapping. Видимость оценивается по структуре монтажа.');
  return {sequences, root, fd, startFrame, endFrame,
    markers: readMarkers(markerRecord), limitations: [...limitations]};
}
