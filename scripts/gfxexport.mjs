#!/usr/bin/env node
// Hand an edit to After Effects (Workflow I, step 2):
//   plate.mov   the edit as it plays, WITHOUT linked graphics — AE's guide layer
//   edit.json   the sequence in whole frames: size, fps, clips, markers (format: references/gfx-plan.md)
//   words.json  what is said, in sequence seconds: the plate is transcribed, so nothing to map
//
//   node scripts/gfxexport.mjs --seq-id <sequenceID> --dir <film>_gfx [--no-words] [--lang ru]
//        [--model large-v3] [--python <exe>]
// `frames` counts the edit only: linked comps (media *.aep) do not lengthen it.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { callBridge } from './lib/prbridge.mjs';
import { loadConfig } from './lib/config.mjs';
import { exportSequence } from './lib/prexport.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : d; };
const SEQ = arg('seq-id'), DIR = arg('dir') && resolve(arg('dir'));
if (!SEQ || !DIR) { console.error('usage: gfxexport.mjs --seq-id <sequenceID> --dir <film>_gfx [--no-words]'); process.exit(2); }
mkdirSync(DIR, { recursive: true });
const cfg = loadConfig();

const dumpJsx = `(function () {
  var p = app.project, s = null, i, j;
  for (i = 0; i < p.sequences.numSequences; i++) { if (String(p.sequences[i].sequenceID) === ${JSON.stringify(SEQ)}) { s = p.sequences[i]; } }
  if (!s) { return JSON.stringify({ ok: false, error: 'sequence not in the focused project ' + p.name }); }
  var tpf = Number(s.timebase), st = s.getSettings(), last = 0;
  var fr = function (t) { return Math.round(Number(t.ticks) / tpf); };
  var tracks = function (T) {
    var out = [];
    for (i = 0; i < T.numTracks; i++) {
      var tr = T[i], clips = [];
      for (j = 0; j < tr.clips.numItems; j++) {
        var c = tr.clips[j], media = c.projectItem ? String(c.projectItem.getMediaPath()) : '';
        var row = { name: String(c.name), media: media, start: fr(c.start), end: fr(c.end), inPoint: fr(c.inPoint) };
        if (media.toLowerCase().slice(-4) !== '.aep' && row.end > last) { last = row.end; }
        clips.push(row);
      }
      out.push({ index: i, clips: clips });
    }
    return out;
  };
  var vt = tracks(s.videoTracks), at = tracks(s.audioTracks), mk = [], m = s.markers.getFirstMarker();
  while (m) { mk.push({ name: String(m.name), comments: String(m.comments), start: fr(m.start), end: fr(m.end) }); m = s.markers.getNextMarker(m); }
  return JSON.stringify({ ok: true, project: String(p.path), sequence: { id: String(s.sequenceID), name: String(s.name),
    fps: 254016000000 / tpf, ticksPerFrame: String(s.timebase), w: st.videoFrameWidth, h: st.videoFrameHeight, frames: last },
    videoTracks: vt, audioTracks: at, markers: mk });
})()`;

const raw = await callBridge('evalJson', [dumpJsx], { mutating: false });
const E = typeof raw === 'string' ? JSON.parse(raw) : raw;
if (!E.ok) { console.error(E.error); process.exit(1); }
delete E.ok;
const seconds = E.sequence.frames / E.sequence.fps;
const rendered = await exportSequence(SEQ, join(DIR, 'plate.mov'), seconds, { withoutGfx: true, fps: E.sequence.fps });
const plate = rendered.out;   // plate.b.mov while AE holds plate.mov
let words = null;
if (!process.argv.includes('--no-words')) {
  const wav = join(DIR, 'words.wav');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', plate, '-map', '0:a:0', '-ac', '1', '-ar', '16000', wav]);
  execFileSync(arg('python', cfg.whisperPython || 'python'), [join(HERE, 'transcribe_local.py'), wav, join(DIR, 'words'),
    '--model', arg('model', 'large-v3'), '--lang', arg('lang', 'ru')], { stdio: 'inherit' });
  words = join(DIR, 'words.json');
  copyFileSync(join(DIR, 'words.words.json'), words);
} else if (existsSync(join(DIR, 'words.json'))) {
  // A transcript of an earlier edit would put every word at the wrong time: move it out of the way.
  renameSync(join(DIR, 'words.json'), join(DIR, 'words.prev.json'));
}
const edit = { version: 1, ...E, plate, words };
writeFileSync(join(DIR, 'edit.json'), JSON.stringify(edit, null, 2));
// The first hand-over starts the plan, with the paths named as references/gfx-plan.md says
// («Files of one film»): the .aep file name must be unique in the project.
const PLAN = join(DIR, 'gfx-plan.json');
let started;
if (!existsSync(PLAN)) {
  const fwd = (p) => String(p).replace(/\\/g, '/');
  const { id, name, fps, w, h, frames } = E.sequence;
  writeFileSync(PLAN, JSON.stringify({ version: 1, sequence: { id, name, fps, w, h, frames }, style: 'cloudru', plate: fwd(plate),
    aep: fwd(join(DIR, `${name.replace(/[\\/:*?"<>|]/g, '_')}_gfx.aep`)), slots: [] }, null, 2));
  started = PLAN;
}
console.log(JSON.stringify({ ok: true, dir: DIR, fps: E.sequence.fps, frames: E.sequence.frames, seconds, plate: rendered, words, markers: E.markers.length, planStarted: started }, null, 2));
