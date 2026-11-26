// Offline editorial picture map. Run node scripts/docmap.mjs --help from the skill root.
import { readFileSync, mkdirSync, writeFileSync, existsSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { prepareSnapshot } from './lib/docsnapshot.mjs';
import { visibleRanges } from './lib/docvisibility.mjs';
import { compareShotList } from './lib/docshotlist.mjs';
import { renderMap } from './lib/docreport.mjs';

const help = `node scripts/docmap.mjs --snapshot FILE --sequence ID_OR_NAME --out DIR
  --metadata FILE        Matching seqdump with frame duration and sequence In/Out
  --saved-project FILE   Supplement a flat inventory with matching saved .prproj clip flags and speeds
  --picture-tracks 1-4   Picture tracks of the selected sequence (default: all; nests keep their stack)
  --include-name REGEX   Also keep these clips on higher/excluded tracks
  --exclude-name REGEX   Exclude these clips from the editorial picture
  --card-name REGEX      Identify graphic cards by their resolved label
  --interview-tracks 1 --interview-name REGEX   Assign interview by track and/or label
  --broll-tracks 1-4     Classify remaining identifiable picture on these tracks as B-roll
  --reference FILE       Compare independently with an archived shots.json and link its JPGs
  --notes FILE           Timed notes/quotes in this sequence (see Workflow H)
Outputs map.json and report.md. Track lists are one-based. Sequence times use [In, Out).`;

function tracks(value) {
  if (value === undefined) return null;
  const result = new Set();
  for (const part of value.split(',')) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part.trim());
    if (!m || +m[1] < 1 || +(m[2] ?? m[1]) < +m[1] || +(m[2] ?? m[1]) > 1000) {
      throw new Error(`Invalid track list: ${value} (example: 1,3-5)`);
    }
    for (let n = +m[1]; n <= +(m[2] ?? m[1]); n++) result.add(n - 1);
  }
  return result;
}

function regex(value) {
  return value === undefined ? null : new RegExp(value, 'iu');
}

function editorialPolicy(args) {
  const picture = tracks(args['picture-tracks']), include = regex(args['include-name']);
  const exclude = regex(args['exclude-name']), card = regex(args['card-name']);
  const interview = tracks(args['interview-tracks']), interviewName = regex(args['interview-name']);
  const broll = tracks(args['broll-tracks']);
  return {
    includeClip(clip) {
      return !exclude?.test(clip.name) && (!picture || picture.has(clip.track) || include?.test(clip.name));
    },
    kind(row) {
      if (row.track == null) return 'unknown';
      if (card?.test(row.label)) return 'card';
      if (!row.path) return 'unknown';
      if ((interview || interviewName) && (!interview || interview.has(row.track))
        && (!interviewName || interviewName.test(row.label))) return 'interview';
      return broll?.has(row.track) ? 'broll' : 'unknown';
    },
  };
}

const readJson = file => JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));

function projectEvidence(file) {
  const helper = fileURLToPath(new URL('./docproject.py', import.meta.url));
  const result = spawnSync('python', ['-I', '-S', helper, resolve(file)], {
    encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.trim() || 'Could not read saved Premiere project');
  return JSON.parse(result.stdout);
}

function writeReports(dir, outputs, contents) {
  mkdirSync(dir, { recursive: true });
  const created = [];
  try {
    for (const [i, file] of outputs.entries()) {
      const handle = openSync(file, 'wx');
      created.push(file);
      try { writeFileSync(handle, contents[i]); } finally { closeSync(handle); }
    }
  } catch (error) {
    for (const file of created) unlinkSync(file);
    throw error;
  }
}

// Path identity is local to the snapshot. Different filenames can still depict the same action.
function fileKey(path) {
  const key = path.replaceAll('\\', '/');
  return /^(?:[A-Za-z]:\/|\/\/)/.test(key) ? key.toLowerCase() : key;
}

const rounded = value => Number(value.toFixed(8));
export function brollUsage(rows) {
  const groups = new Map();
  for (const row of rows.filter(row => row.kind === 'broll' && row.path)) {
    const key = fileKey(row.path);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const sources = [], relations = [];
  for (const uses of groups.values()) {
    sources.push({ path: uses[0].path, rows: uses.map(row => row.id) });
    for (const [i, a] of uses.entries()) {
      for (const b of uses.slice(i + 1)) {
        let type = 'unknown', overlap = null;
        if (a.still && b.still) {
          type = 'same-still';
        } else if ([a.sourceStart, a.sourceEnd, b.sourceStart, b.sourceEnd].every(Number.isFinite)) {
          const start = rounded(Math.max(a.sourceStart, b.sourceStart));
          const end = rounded(Math.min(a.sourceEnd, b.sourceEnd));
          type = 'different-interval';
          if (end > start) {
            overlap = [start, end];
            type = rounded(a.sourceStart) === rounded(b.sourceStart) && rounded(a.sourceEnd) === rounded(b.sourceEnd)
              ? 'same-interval' : 'partial-overlap';
          }
        }
        const linearAssumption = [a, b].some(row => row.issues?.includes('source-timing-assumed'));
        relations.push({ rows: [a.id, b.id], type, overlap, linearAssumption });
      }
    }
  }
  return { sources, relations };
}

function noteRows(notes, root, fd) {
  if (notes.sequenceId !== root.id || !Array.isArray(notes.entries)) {
    throw new Error('--notes requires the selected sequenceId and an entries array');
  }
  const seen = new Set();
  return notes.entries.map((n, i) => {
    if (!Number.isInteger(n.startFrame) || !Number.isInteger(n.endFrame) || n.startFrame < 0
      || n.endFrame < n.startFrame || !['quote', 'note'].includes(n.type)
      || typeof n.text !== 'string' || !n.text.trim() || typeof n.source !== 'string' || !n.source.trim()) {
      throw new Error(`Invalid note at entries[${i}]: supply a frame interval, type, text and source`);
    }
    const id = 'note:' + (n.id ?? i);
    if (seen.has(id)) throw new Error(`Duplicate note id: ${id}`);
    seen.add(id);
    return { id, type: n.type, start: n.startFrame * fd, end: n.endFrame * fd,
      startFrame: n.startFrame, endFrame: n.endFrame, text: n.text, source: n.source,
      speaker: n.speaker ?? null, language: n.language ?? null };
  });
}

export function attachNotes(rows, notes, fd) {
  // Snap only floating-point noise at an exact edge. An off-grid point
  // belongs to the picture already on screen; a span can touch two frames.
  function framePosition(seconds) {
    const pos = seconds / fd;
    return Math.abs(pos - Math.round(pos)) < 1e-7 ? Math.round(pos) : pos;
  }
  for (const note of notes) {
    const start = note.startFrame ?? Math.floor(framePosition(note.start));
    const end = note.endFrame ?? (note.start === note.end ? start : Math.ceil(framePosition(note.end)));
    note.startFrame = start;
    note.endFrame = end;
    note.rows = [];
    for (const row of rows) {
      const touches = start === end ? row.startFrame <= start && start < row.endFrame
        : row.startFrame < end && start < row.endFrame;
      if (touches) {
        (row.notes ??= []).push(note.id);
        note.rows.push(row.id);
      }
    }
  }
}

function main() {
  const names = ['snapshot', 'sequence', 'out', 'metadata', 'saved-project', 'picture-tracks', 'include-name',
    'exclude-name', 'card-name', 'interview-tracks', 'interview-name', 'broll-tracks', 'reference', 'notes'];
  const options = Object.fromEntries(names.map(key => [key, { type: 'string' }]));
  options.help = { type: 'boolean' };
  const { values: args } = parseArgs({ options });
  if (args.help) { console.log(help); return; }
  if (!args.snapshot || !args.out || !args.sequence) throw new Error(help);
  const dir = resolve(args.out), outputs = ['map.json', 'report.md'].map(name => join(dir, name));
  if (outputs.some(file => existsSync(file))) throw new Error('Output already contains map.json or report.md. Choose a fresh directory.');
  const policy = editorialPolicy(args);
  const { sequences, root, fd, startFrame, endFrame, markers, limitations } =
    prepareSnapshot(readJson(args.snapshot), args.sequence, args.metadata && readJson(args.metadata),
      args['saved-project'] && projectEvidence(args['saved-project']));
  const rows = visibleRanges(sequences, root, fd, startFrame, endFrame,
    (clip, sequence) => sequence.id !== root.id || policy.includeClip(clip));
  for (const row of rows) {
    row.id = `F${row.startFrame}`;
    row.kind = policy.kind(row);
  }
  const notes = markers.map((m, i) => ({ id: `marker:${m.id ?? i}`, type: 'marker', start: m.start,
    end: m.end, name: m.name, text: m.comment, source: 'sequence marker' }));
  if (args.notes) notes.push(...noteRows(readJson(args.notes), root, fd));
  attachNotes(rows, notes, fd);
  const comparison = args.reference ? compareShotList(rows, readJson(args.reference), fd, resolve(args.reference)) : null;
  const usage = brollUsage(rows);
  const inputs = Object.fromEntries(['snapshot','metadata','saved-project','reference','notes'].filter(k => args[k])
    .map(k => [k, relative(dir, resolve(args[k])).replaceAll('\\','/')]));
  const rules = Object.fromEntries(Object.entries(args).filter(([k]) => ![...Object.keys(inputs), 'out', 'sequence'].includes(k)));
  const map = { version: 1, sequence: { id: root.id, name: root.name, fd, fps: 1/fd, startFrame, endFrame },
    inputs, rules, limitations, rows, notes, usage, comparison };
  const report = renderMap(map, dir);
  writeReports(dir, outputs, [JSON.stringify(map, null, 2) + '\n', report]);
  console.log(`${root.name}: ${rows.length} ranges, ${rows.filter(r => r.kind === 'broll').length} B-roll, ${usage.sources.length} B-roll sources.\n${outputs.join('\n')}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
