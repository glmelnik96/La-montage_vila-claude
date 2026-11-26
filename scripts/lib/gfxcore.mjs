// Pure helpers for a graphics pass over an edit (Workflow I, references/gfx-plan.md): the plan
// format, frame/tick math, the chat table, re-anchoring after a re-edit, track choice. No Premiere,
// no AE, no I/O — the live scripts import these and scripts/tests/ exercises them.

import contract from './gfx-contract.cjs';
export const { TYPES, LAYERS, secToFrames, cutsOf } = contract;

// Pure API for callers with an already loaded kit. File-based entry points use inspectPlan.
export function validatePlan(plan, edit, kit) {
  const { ok, errors, warnings } = contract.inspectData(plan, kit, edit);
  return { ok, errors, warnings };
}

export const framesToSec = (frames, fps) => frames / fps;

// Premiere counts ticks; ticksPerFrame comes from the sequence (seq.timebase), so 29.97 and 23.976
// stay exact. BigInt: a long film passes 2^53 ticks.
export function framesToTicks(frames, ticksPerFrame) {
  return (BigInt(frames) * BigInt(ticksPerFrame)).toString();
}
export function ticksToFrames(ticks, ticksPerFrame) {
  const t = BigInt(ticks), p = BigInt(ticksPerFrame);
  return Number((t + p / 2n) / p);
}

const clock = (frames, fps) => {
  const s = frames / fps, m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`;
};
const cell = (v) => String(v).replace(/[\r\n]+/g, ' ').replace(/\|/g, '/');

// The table that goes to the chat for approval: one row per slot.
export function planTable(plan, mappings = []) {
  const fps = plan.sequence.fps;
  if (plan.kit) {
    const byId = new Map(mappings.map(m => [m.id, m]));
    const rows = ['| Слот | Время | Редакционный тип | Оформление / слой | Композиция | Поля шаблона | Почему |',
      '|---|---|---|---|---|---|---|'];
    for (const s of plan.slots) {
      const m = byId.get(s.id);
      const fields = m?.fields.map(f => `${f.key}${f.required ? '' : '?'} → TXT_${f.target.toUpperCase()} = ${f.value || '∅'}`).join(' · ');
      const values = [s.id, clock(s.in, fps) + '–' + clock(s.out, fps), s.type, s.visualRole + ' / ' + s.layer,
        s.lost ? 'потеряно' : m?.template || '—', fields || '—', s.why || ''];
      rows.push('| ' + values.map(cell).join(' | ') + ' |');
    }
    return rows.join('\n');
  }
  const rows = ['| # | Время | Тип | Текст | Почему |', '|---|---|---|---|---|'];
  plan.slots.forEach((s, i) => {
    const label = (TYPES[s.type] || { label: s.type }).label + (s.lost ? ' (потеряно)' : '');
    const text = Object.values(s.text || {}).map(cell).join(' · ') || '—';
    rows.push(`| ${i + 1} | ${clock(s.in, fps)}–${clock(s.out, fps)} | ${label} | ${text} | ${cell(s.why || '')} |`);
  });
  return rows.join('\n');
}

// Words compared the way a reader would: no case, ё = е, no punctuation or dashes.
export function norm(s) {
  return String(s).toLowerCase().replace(/ё/g, 'е')
    .replace(/[«»"'“”„.,!?…:;()[\]—–-]/g, ' ').replace(/\s+/g, ' ').trim();
}

// Every place `text` is said: [{ i, t }] = index of its first word in `words` and that word's start.
// A match must start on a word boundary; a word that normalizes to several tokens ("ну-ка") still
// matches token by token.
export function findAnchor(words, text) {
  const want = norm(text).split(' ').filter(Boolean);
  const toks = [];
  words.forEach((w, i) => norm(w.w).split(' ').filter(Boolean).forEach((t) => toks.push({ t, i })));
  const hits = [];
  if (!want.length) return hits;
  for (let k = 0; k + want.length <= toks.length; k++) {
    if (k > 0 && toks[k - 1].i === toks[k].i) continue;
    let ok = true;
    for (let j = 0; j < want.length && ok; j++) ok = toks[k + j].t === want[j];
    if (ok) hits.push({ i: toks[k].i, t: words[toks[k].i].s });
  }
  return hits;
}

// Re-anchor every slot on a NEW cut. words → the occurrence nearest the slot's old time; marker →
// the marker of that name (both keep the slot's length). time or no anchor → follow the slot's own
// clip(s) in edit.json (the ripple tools move them; a clip the ripple split is re-joined over its
// span); with no clip it is left alone and reported in `manual`. A slot whose anchor is gone or would
// fall outside the cut is marked lost — never deleted. The plan takes the new edit's plate as well:
// it is plate.b.mov when AE held plate.mov during the export (prexport.freePath).
export function resyncSlots(plan, words, edit) {
  const fps = plan.sequence.fps;
  const aepFile = String(plan.aep).replace(/\\/g, '/').split('/').pop();
  const clipsOf = (id) => (edit.videoTracks || []).flatMap((t) => t.clips || []).filter((c) => c.name === `${id}/${aepFile}`);
  const out = JSON.parse(JSON.stringify(plan));
  out.sequence = { ...out.sequence, id: edit.sequence.id, name: edit.sequence.name, frames: edit.sequence.frames };
  if (edit.plate) out.plate = String(edit.plate).replace(/\\/g, '/');
  const moved = [], lost = [], manual = [];
  for (const s of out.slots) {
    const a = s.anchor || { kind: 'time' };
    let to = null;
    if (a.kind === 'words' || a.kind === 'marker') {
      let at = null;
      if (a.kind === 'words') {
        const hits = findAnchor(words, a.text);
        if (hits.length) {
          const old = s.in / fps;
          at = secToFrames(hits.reduce((b, h) => (Math.abs(h.t - old) < Math.abs(b.t - old) ? h : b)).t, fps) + (a.offset || 0);
        }
      } else {
        const m = (edit.markers || []).find((x) => x.name === a.text);
        if (m) at = m.start + (a.offset || 0);
      }
      if (at !== null) to = [at, at + (s.out - s.in)];
    } else {
      const cl = clipsOf(s.id);
      if (!cl.length) { manual.push(s.id); continue; }
      to = [Math.min(...cl.map((c) => c.start)), Math.max(...cl.map((c) => c.end))];
    }
    if (!to || to[0] < 0 || to[1] > edit.sequence.frames) { s.lost = true; lost.push(s.id); continue; }
    delete s.lost;
    if (to[0] !== s.in || to[1] !== s.out) { moved.push({ id: s.id, from: [s.in, s.out], to }); s.in = to[0]; s.out = to[1]; }
  }
  return { plan: out, moved, lost, manual };
}

const slash = (p) => String(p).replace(/\\/g, '/').toLowerCase();

// Video tracks for a pass: the first track above everything the edit uses (V1 picture, slides,
// B-roll), then logo, then insert. Clips of THIS pass (media = the plan's .aep) do not count, so
// a second run finds the same tracks. A saved state wins over both.
export function pickTracks(edit, planAep, state) {
  if (state && state.tracks) return state.tracks;
  const ours = slash(planAep);
  let top = -1;
  for (const t of edit.videoTracks) {
    if (t.clips.some((c) => slash(c.media) !== ours)) top = Math.max(top, t.index);
  }
  return { overlay: top + 1, logo: top + 2, insert: top + 3 };
}

// What gfxplace hands the host: one row per slot that is not lost. A linked comp's Premiere item is
// named <comp name>/<aep file name> (live-verified), and the comp is named after the slot id.
export function placeRows(plan, tracks) {
  const aepFile = String(plan.aep).replace(/\\/g, '/').split('/').pop();
  return plan.slots.filter((s) => !s.lost).map((s) => ({ id: s.id, item: `${s.id}/${aepFile}`, track: tracks[s.layer], inF: s.in, outF: s.out }));
}
