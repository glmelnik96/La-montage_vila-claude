// Render a sequence from the Premiere host. For the AE plate the linked graphics must NOT be in
// the picture: a throwaway clone without them is rendered and then deleted (the recipe in
// SKILL.md «Rendering and looking»). exportAsMediaDirect is synchronous inside Premiere; if the
// bridge gives up first the render keeps going, so a timeout is answered by waiting for the file
// to settle — never by calling again (that starts a second render).
import { existsSync, renameSync } from 'node:fs';
import { callBridge } from './prbridge.mjs';
import { loadConfig } from './config.mjs';
import { probeDuration, waitStable } from './media.mjs';

const fwd = (p) => String(p).replace(/\\/g, '/');   // JSX source must not contain backslashes

export function presetPath() {
  const dir = loadConfig().premiereDir || 'C:/Program Files/Adobe/Adobe Premiere Pro 2026';
  return `${dir}/MediaIO/systempresets/3F3F3F3F_4D6F6F56/H264 Match Source - High bitrate.epr`;
}

export function exportJsx(seqId, out, preset, withoutGfx) {
  return `(function () {
  var SEQ = ${JSON.stringify(seqId)}, OUT = ${JSON.stringify(fwd(out))}, PRESET = ${JSON.stringify(fwd(preset))}, STRIP = ${withoutGfx ? 'true' : 'false'};
  var p = app.project, s = null, clone = null, i, j, k;
  for (i = 0; i < p.sequences.numSequences; i++) { if (String(p.sequences[i].sequenceID) === SEQ) { s = p.sequences[i]; } }
  if (!s) { return JSON.stringify({ ok: false, error: 'sequence ' + SEQ + ' is not in the focused project ' + p.name }); }
  var isGfx = function (c) { var q = c.projectItem; return !!q && String(q.getMediaPath()).toLowerCase().slice(-4) === '.aep'; };
  var strip = function (T) { for (k = 0; k < T.numTracks; k++) { for (j = T[k].clips.numItems - 1; j >= 0; j--) { if (isGfx(T[k].clips[j])) { T[k].clips[j].remove(false, false); } } } };
  var has = false;
  if (STRIP) { for (k = 0; k < s.videoTracks.numTracks; k++) { for (j = 0; j < s.videoTracks[k].clips.numItems; j++) { if (isGfx(s.videoTracks[k].clips[j])) { has = true; } } } }
  var target = s;
  if (has) {
    var ids = {};
    for (i = 0; i < p.sequences.numSequences; i++) { ids[String(p.sequences[i].sequenceID)] = 1; }
    s.clone();
    for (i = 0; i < p.sequences.numSequences; i++) { if (!ids[String(p.sequences[i].sequenceID)]) { clone = p.sequences[i]; } }
    if (!clone) { return JSON.stringify({ ok: false, error: 'the throwaway clone did not appear' }); }
    clone.name = s.name + ' _plate_tmp';
    strip(clone.videoTracks); strip(clone.audioTracks);
    target = clone;
  }
  p.activeSequence = target;
  var r = target.exportAsMediaDirect(new File(OUT).fsName, new File(PRESET).fsName, app.encoder.ENCODE_ENTIRE);
  if (clone) { p.activeSequence = s; p.deleteSequence(clone); }
  return JSON.stringify({ ok: String(r) === 'No Error', result: String(r), withoutGfx: !!clone });
})()`;
}

// Where to render `out`. An old file there is kept as <name>.prev.<ext>. After Effects holds every file
// it has imported, so under a live build the plate cannot be moved (EBUSY): the other name of the
// pair, <name>.b.<ext>, is used then. The caller takes the path returned.
export function freePath(out, rename = renameSync) {
  const alt = out.replace(/(\.[^.]+)$/, '.b$1');
  for (const p of [out, alt]) {
    if (!existsSync(p)) return p;
    try { rename(p, p.replace(/(\.[^.]+)$/, '.prev$1')); return p; } catch (e) { if (e.code !== 'EBUSY' && e.code !== 'EPERM') throw e; }
  }
  throw new Error(`${out} and ${alt} are both in use: close them in After Effects or the player`);
}

// Render `seqId` to `out` — or to the other name of the pair, see freePath — and prove the length.
// `seconds` = the length expected. Returns { out: the path written, duration, withoutGfx }.
export async function exportSequence(seqId, want, seconds, { withoutGfx = false, fps = 25 } = {}) {
  const out = freePath(want);
  let res = null;
  try {
    const r = await callBridge('evalJson', [exportJsx(seqId, out, presetPath(), withoutGfx)], { timeoutMs: Math.max(120000, seconds * 1000) });
    res = typeof r === 'string' ? JSON.parse(r) : r;
    if (!res.ok) throw new Error('exportAsMediaDirect: ' + (res.error || res.result));
  } catch (e) {
    if (!/timeout|не ответил/i.test(String(e.message))) throw e;
    console.error('the bridge gave up; the render keeps going — waiting for the file to settle');
  }
  await waitStable(out);
  const duration = probeDuration(out);
  if (Math.abs(duration - seconds) > 1.5 / fps) throw new Error(`${out}: ${duration.toFixed(3)} s rendered, ${seconds.toFixed(3)} s expected`);
  return { out, duration, withoutGfx: res ? res.withoutGfx : null };
}
