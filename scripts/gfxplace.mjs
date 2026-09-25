#!/usr/bin/env node
// Bring the graphics pass into the edit (Workflow I, step 6): import the slot comps from the .aep
// through Dynamic Link, lay each on its track at its exact frame, strip any audio they carry. The strip
// covers every clip from this .aep, slot or not: a comp Premiere first met with audio keeps it.
//
//   node scripts/gfxplace.mjs --plan <film>_gfx/gfx-plan.json [--edit <edit.json>] [--state <gfx-state.json>] [--prune]
//
// Save the .aep first (gfx-build.js does): Dynamic Link reads the saved file whenever AE has another
// project open. Safe to re-run — also after a bridge timeout: items already in the GFX bin are reused
// by name (<comp>/<aep file>), clips already on their frame are kept, a clip on the wrong frame is
// removed and placed again (TrackItem.move() breaks track order), lost slots are left alone.
// A clip of this .aep whose slot is no longer in the plan is an orphan: reported, and removed only
// with --prune (when the user asked for that slot to go).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { callBridge } from './lib/prbridge.mjs';
import { validatePlan, pickTracks, placeRows } from './lib/gfxcore.mjs';

const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : undefined; };
const read = (p) => JSON.parse(readFileSync(p, 'utf8'));
if (!arg('plan')) { console.error('usage: gfxplace.mjs --plan <gfx-plan.json> [--edit <edit.json>] [--state <gfx-state.json>] [--prune]'); process.exit(2); }
const PLAN = resolve(arg('plan')), DIR = dirname(PLAN);
const plan = read(PLAN), edit = read(arg('edit') || join(DIR, 'edit.json'));
const STATE = arg('state') || join(DIR, 'gfx-state.json');
const v = validatePlan(plan, edit);
if (!v.ok) { console.log(JSON.stringify(v, null, 2)); process.exit(1); }
if (!existsSync(plan.aep)) { console.error(`no .aep at ${plan.aep}: run ae-motion-live scripts/gfx-build.js first`); process.exit(1); }
const tracks = pickTracks(edit, plan.aep, existsSync(STATE) ? read(STATE) : null);
const rows = placeRows(plan, tracks);
const aep = plan.aep.replace(/\\/g, '/');
const tail = `/${aep.split('/').pop()}`;
const payload = { seqId: plan.sequence.id, aep, tail, fps: plan.sequence.fps,
  needTracks: Math.max(tracks.overlay, tracks.logo, tracks.insert) + 1, rows,
  lost: plan.slots.filter((s) => s.lost).map((s) => s.id + tail), prune: process.argv.includes('--prune') };

// ES3, and no backslash anywhere in the source (the bridge mangles them): paths travel with '/'.
const jsx = `(function () {
  var P = ${JSON.stringify(payload)};
  var p = app.project, s = null, i, j, k;
  for (i = 0; i < p.sequences.numSequences; i++) { if (String(p.sequences[i].sequenceID) === P.seqId) { s = p.sequences[i]; } }
  if (!s) { return JSON.stringify({ ok: false, error: 'sequence not in the focused project ' + p.name }); }
  p.activeSequence = s;
  var tpf = Number(s.timebase);
  var fr = function (t) { return Math.round(Number(t.ticks) / tpf); };
  var bin = null;
  for (i = 0; i < p.rootItem.children.numItems; i++) { var c = p.rootItem.children[i]; if (c.name === 'GFX' && c.type === 2) { bin = c; } }
  if (!bin) { bin = p.rootItem.createBin('GFX'); }
  var find = function (name) { for (var q = 0; q < bin.children.numItems; q++) { if (bin.children[q].name === name) { return bin.children[q]; } } return null; };
  var need = [];
  for (i = 0; i < P.rows.length; i++) { if (!find(P.rows[i].item)) { need.push(P.rows[i].id); } }
  if (need.length) { p.importAEComps(new File(P.aep).fsName, need, bin); }
  var missing = [];
  for (i = 0; i < P.rows.length; i++) { if (!find(P.rows[i].item)) { missing.push(P.rows[i].item); } }
  if (missing.length) { return JSON.stringify({ ok: false, error: 'not imported through Dynamic Link: ' + missing.join(', ') }); }
  if (s.videoTracks.numTracks < P.needTracks) {
    app.enableQE();
    qe.project.getActiveSequence().addTracks(P.needTracks - s.videoTracks.numTracks, s.videoTracks.numTracks, 0);
  }
  if (s.videoTracks.numTracks < P.needTracks) { return JSON.stringify({ ok: false, error: 'could not add video tracks: have ' + s.videoTracks.numTracks + ', need ' + P.needTracks }); }
  var placed = 0, kept = 0, strippedAudio = 0;
  var ours = function (n) { n = String(n); return n.length > P.tail.length && n.substr(n.length - P.tail.length) === P.tail; };
  for (i = 0; i < P.rows.length; i++) {
    var r = P.rows[i], ok = false;
    for (k = 0; k < s.videoTracks.numTracks; k++) {
      var tr = s.videoTracks[k];
      for (j = tr.clips.numItems - 1; j >= 0; j--) {
        var cl = tr.clips[j];
        if (String(cl.name) !== r.item) { continue; }
        if (k === r.track && !ok && fr(cl.start) === r.inF && fr(cl.end) === r.outF) { ok = true; kept++; } else { cl.remove(false, false); }
      }
    }
    if (!ok) { s.videoTracks[r.track].overwriteClip(find(r.item), r.inF / P.fps + 0.001); placed++; }
  }
  for (k = 0; k < s.audioTracks.numTracks; k++) {
    var at = s.audioTracks[k];
    for (j = at.clips.numItems - 1; j >= 0; j--) { if (ours(at.clips[j].name)) { at.clips[j].remove(false, false); strippedAudio++; } }
  }
  var planned = {}, orphans = [];
  for (i = 0; i < P.rows.length; i++) { planned[P.rows[i].item] = 1; }
  for (i = 0; i < P.lost.length; i++) { planned[P.lost[i]] = 1; }
  for (k = 0; k < s.videoTracks.numTracks; k++) {
    var ot = s.videoTracks[k];
    for (j = ot.clips.numItems - 1; j >= 0; j--) {
      var on = String(ot.clips[j].name);
      if (!ours(on) || planned[on]) { continue; }
      orphans.push({ item: on, track: k, start: fr(ot.clips[j].start), end: fr(ot.clips[j].end) });
      if (P.prune) { ot.clips[j].remove(false, false); }
    }
  }
  var report = [];
  for (i = 0; i < P.rows.length; i++) {
    var q2 = P.rows[i], t2 = s.videoTracks[q2.track], got = null;
    for (j = 0; j < t2.clips.numItems; j++) { if (String(t2.clips[j].name) === q2.item) { got = t2.clips[j]; } }
    if (!got) { report.push({ id: q2.id, ok: false, error: 'not on V' + (q2.track + 1) }); continue; }
    if (fr(got.start) === q2.inF && fr(got.end) !== q2.outF) {
      var d = new Time(); d.ticks = String((q2.outF - q2.inF) * tpf); got.outPoint = d;
      var e = new Time(); e.ticks = String(q2.outF * tpf); got.end = e;
    }
    report.push({ id: q2.id, track: q2.track, start: fr(got.start), end: fr(got.end), ok: fr(got.start) === q2.inF && fr(got.end) === q2.outF });
  }
  return JSON.stringify({ ok: true, placed: placed, kept: kept, strippedAudio: strippedAudio, orphans: orphans, pruned: P.prune ? orphans.length : 0, slots: report });
})()`;

const raw = await callBridge('evalJson', [jsx], { timeoutMs: 180000 });
const R = typeof raw === 'string' ? JSON.parse(raw) : raw;
if (!R.ok) { console.error(R.error); process.exit(1); }
const slots = {};
for (const r of rows) slots[r.id] = { item: r.item, track: r.track, in: r.inF, out: r.outF };
writeFileSync(STATE, JSON.stringify({ version: 1, aep: plan.aep, tracks, slots }, null, 2));
const bad = R.slots.filter((s) => !s.ok);
const warning = R.orphans.length && !R.pruned
  ? `${R.orphans.map((o) => o.item).join(', ')}: no longer in the plan; run again with --prune once the user wants them gone` : undefined;
console.log(JSON.stringify({ ok: bad.length === 0, tracks, ...R, warning }, null, 2));
process.exitCode = bad.length ? 1 : 0;
