// The picture track policy is editorial. Masks, blending and motion cannot be
// reconstructed from this structural snapshot. Keep the exact affected windows.
const stillPath = /\.(?:png|jpe?g|tiff?|bmp|psd|webp|heic)$/i;
const seconds = t => Math.round(t * 1e9) / 1e9;
const warning = (issue, detail = '') => ({ issue, detail });

function sourceClock(clip) {
  if (clip.reverse) return { issue: 'reverse-source-unresolved' };
  if (clip.hasRetime || clip.effects?.some(fx => /time\s*remap/i.test(fx.match + ' ' + fx.name))) {
    return { issue: 'time-remapping-unresolved' };
  }
  if (!Number.isFinite(clip.sourceIn) || !Number.isFinite(clip.sourceOut)) {
    return { issue: 'source-bounds-missing' };
  }
  const rate = clip.speed ?? 1;
  const expected = (clip.end - clip.start) * rate;
  // seqdump rounds its fields to milliseconds. A span ratio alone cannot
  // establish a constant speed, nor the shape of a time-remapping curve.
  if (!Number.isFinite(rate) || rate <= 0 || Math.abs(clip.sourceOut - clip.sourceIn - expected) > 0.0021 * Math.max(1, rate)) {
    return { issue: 'source-timing-unresolved' };
  }
  return { rate };
}

function knownPath(path) {
  return typeof path === 'string' && path.trim() !== '' && !/^\d+$/.test(path);
}

/** Whole edit frames, half-open. All source positions are seconds in the media.
 * includeClip selects the editorial picture on every level of the nest. */
export function visibleRanges(sequences, root, fd, startFrame, endFrame, includeClip = () => true) {
  if (!(Number.isFinite(fd) && fd > 0 && Number.isSafeInteger(startFrame) && Number.isSafeInteger(endFrame) && endFrame >= startFrame)) {
    throw new Error('Expected a positive frame duration and an ordered edit frame range');
  }
  const rows = [];
  let previousKey;
  let issueEnds;

  function append(key, data, a, b, warnings) {
    let row = rows.at(-1);
    // An editor can blade a nest without changing picture. Preserve both
    // placements while reporting one continuous use of the same source.
    const continuous = row && row.path && row.path === data.path && row.track === data.track &&
      row.label === data.label && data.sourceStart !== null && row.sourceEnd !== null &&
      Math.abs(row.sourceEnd - data.sourceStart) < 1e-7 && row.sourceRate === data.sourceRate;
    if (row?.endFrame === a && (previousKey === key || continuous)) {
      if (key !== previousKey) {
        row.placements ??= [{ chain: row.chain, startFrame: row.startFrame, endFrame: a }];
        row.placements.push({ chain: data.chain, startFrame: a, endFrame: b });
      } else if (row.placements) row.placements.at(-1).endFrame = b;
      row.endFrame = b;
      row.sourceEnd = data.sourceEnd;
    } else {
      row = { ...data, startFrame: a, endFrame: b, issues: [], issueRanges: [] };
      rows.push(row);
      issueEnds = new Map();
    }
    previousKey = key;
    for (const note of warnings) {
      const id = JSON.stringify([note.issue, note.detail]);
      const prev = issueEnds.get(id);
      if (prev?.endFrame === b) continue;
      if (prev?.endFrame === a) {
        prev.endFrame = b;
      } else {
        const interval = { ...note, startFrame: a, endFrame: b };
        row.issueRanges.push(interval);
        issueEnds.set(id, interval);
        if (!row.issues.includes(note.issue)) row.issues.push(note.issue);
      }
    }
  }

  // Local sequence seconds = base + (root edit seconds * rate).
  function walk(seq, a, b, base, rate, parents, ancestry, inherited) {
    const events = new Map([[a, []], [b, []]]);
    const activeClips = new Set(), activeTransitions = new Set();
    const frameOf = t => Math.max(a, Math.min(b, Math.ceil((t - base) / rate / fd - 0.5 - 1e-9)));
    function schedule(item, index, active) {
      if (!Number.isFinite(item.start) || !Number.isFinite(item.end)) return;
      const begin = frameOf(item.start), end = frameOf(item.end);
      if (end <= begin) return;
      for (const [frame, add] of [[begin, true], [end, false]]) {
        if (!events.has(frame)) events.set(frame, []);
        events.get(frame).push({ active, index, add });
      }
    }
    seq.clips.forEach((c, index) => {
      if (!c.disabled && !c.hidden && !seq.hiddenTracks?.has(c.track)) schedule(c, index, activeClips);
    });
    const transitions = seq.transitions ?? [];
    transitions.forEach((tr, index) => {
      if (!seq.hiddenTracks?.has(tr.track)) schedule(tr, index, activeTransitions);
    });
    const times = [...events.keys()].sort((x, y) => x - y);
    for (let i = 0; i + 1 < times.length; ++i) {
      const lo = times[i], hi = times[i + 1];
      for (const { active, index, add } of events.get(lo)) {
        if (add) active.add(index);
        else active.delete(index);
      }
      const candidates = [...activeClips].sort((x, y) => seq.clips[y].track - seq.clips[x].track || x - y);
      const index = candidates.find(n => includeClip(seq.clips[n], seq));
      const clip = seq.clips[index];
      const warnings = [...inherited];
      const track = clip?.track ?? -1;
      const detail = c => seq.name + ' / V' + (c.track + 1) + ' / ' + c.name;
      for (const n of candidates) {
        const other = seq.clips[n];
        if (other.track >= track && !includeClip(other, seq)) warnings.push(warning('excluded-overlay', detail(other)));
        else if (index !== n && other.track === track) warnings.push(warning('same-track-overlap', detail(other)));
      }
      for (const n of activeTransitions) {
        const tr = transitions[n];
        if (tr.track >= track) warnings.push(warning('transition', detail(tr)));
      }
      if (clip && candidates.some(n => seq.clips[n].track < track)) {
        warnings.push(warning('composite-unverified', detail(clip)));
      }
      const chain = clip ? [...parents, { sequenceId: seq.id, track, name: clip.name, id: clip.id, index }] : parents;
      const key = JSON.stringify([chain.map(c => [c.sequenceId, c.index]), !clip]);
      const data = {
        path: null, label: chain.map(c => c.name).join(' > '), track: chain[0]?.track ?? null,
        chain, still: false, sourceStart: null, sourceEnd: null, sourceRate: null,
      };
      if (!clip) {
        warnings.push(warning(parents.length ? 'empty-nest' : 'picture-gap', seq.name));
      } else {
        for (const issue of clip.issues ?? []) warnings.push(warning(issue, detail(clip)));
        if (clip.effects?.some(fx => /mask|matte|opacity|keying|track.?matte/i.test(fx.match + ' ' + fx.name))) {
          warnings.push(warning('mask-opacity-unresolved', detail(clip)));
        }
        const clock = sourceClock(clip);
        const assumedTiming = !clock.issue && (clip.speed == null || clip.reverse == null);
        const nextBase = clip.sourceIn + (base - clip.start) * clock.rate;
        const nextRate = rate * clock.rate;
        if (clip.nest) {
          if (ancestry.includes(clip.nest)) warnings.push(warning('nest-cycle', detail(clip)));
          else if (!sequences.has(clip.nest)) warnings.push(warning('nest-missing', detail(clip)));
          else if (clock.issue) warnings.push(warning(clock.issue, detail(clip)));
          else {
            const nested = sequences.get(clip.nest);
            if (assumedTiming) warnings.push(warning('source-timing-assumed', detail(clip)));
            if (!Number.isFinite(nested.fd) || nested.fd <= 0) warnings.push(warning('nested-frame-rate-missing', nested.name));
            else if (Math.abs(nested.fd - fd) > 1e-7 || nextRate !== 1) {
              warnings.push(warning('nested-frame-sampling-unverified', nested.name));
            }
            walk(nested, lo, hi, nextBase, nextRate, chain, [...ancestry, clip.nest], warnings);
            continue;
          }
        } else if (!knownPath(clip.path)) {
          warnings.push(warning('source-unidentified', detail(clip)));
        } else {
          data.path = clip.path;
          data.still = stillPath.test(clip.path);
          if (data.still) warnings.push(warning('still-image', detail(clip)));
          else if (clock.issue) warnings.push(warning(clock.issue, detail(clip)));
          else {
            if (assumedTiming) warnings.push(warning('source-timing-assumed', detail(clip)));
            data.sourceRate = nextRate;
            data.sourceStart = seconds(Math.max(clip.sourceIn, nextBase + lo * fd * nextRate));
            data.sourceEnd = seconds(Math.min(clip.sourceOut, nextBase + hi * fd * nextRate));
          }
        }
      }
      append(key, data, lo, hi, warnings);
    }
  }
  walk(root, startFrame, endFrame, 0, 1, [], [root.id], []);
  return rows;
}
