// Pure helpers for a graphics pass over an edit (Workflow I, references/gfx-plan.md): the plan
// format, frame/tick math, the chat table, re-anchoring after a re-edit, track choice. No Premiere,
// no AE, no I/O — the live scripts import these and scripts/tests/ exercises them.

// One row per graphic type. layer: overlay (over the picture), logo (its own track, may span the
// film), insert (full screen, the edit's sound runs under it). fields are required, optional are
// allowed. minSec is the planner's floor; the AE side checks the exact minimum from the template.
// max: characters per field (the template's BOX is the real limit, checked when AE builds).
export const TYPES = {
  lower_third: { layer: 'overlay', label: 'плашка', fields: ['name', 'role'], optional: [], minSec: 3, max: { name: 40, role: 60 } },
  quote: { layer: 'overlay', label: 'ключевая мысль', fields: ['quote'], optional: ['author'], minSec: 3.5, max: { quote: 140, author: 60 } },
  callout: { layer: 'overlay', label: 'выноска', fields: ['value'], optional: ['caption'], minSec: 3, max: { value: 24, caption: 60 } },
  logo: { layer: 'logo', label: 'логотип', fields: [], optional: [], minSec: 3, max: {} },
  chapter: { layer: 'insert', label: 'карточка главы', fields: ['title'], optional: ['subtitle', 'number'], minSec: 3, max: { title: 60, subtitle: 80, number: 24 } },
  intro: { layer: 'insert', label: 'заставка', fields: ['title'], optional: ['subtitle'], minSec: 3.5, max: { title: 60, subtitle: 80 } },
  outro: { layer: 'insert', label: 'концовка', fields: ['title'], optional: ['subtitle'], minSec: 3.5, max: { title: 60, subtitle: 80 } },
};
export const LAYERS = ['overlay', 'logo', 'insert'];

export const secToFrames = (sec, fps) => Math.round(sec * fps);
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

const ID_RE = /^[A-Z][A-Z0-9_]{1,39}$/;
const isInt = (v) => Number.isInteger(v);
const isAbs = (p) => typeof p === 'string' && /^([A-Za-z]:[\\/]|\/)/.test(p);

// { ok, errors, warnings }. With `edit` (edit.json) it also refuses a plan made for another cut.
export function validatePlan(plan, edit) {
  const errors = [], warnings = [];
  const err = (m) => errors.push(m);
  if (!plan || plan.version !== 1) err('version must be 1');
  const seq = plan && plan.sequence;
  if (!seq || !(seq.fps > 0) || !isInt(seq.frames) || seq.frames <= 0 || !isInt(seq.w) || !isInt(seq.h)) err('sequence needs fps > 0 and whole frames, w, h');
  if (edit && seq && (seq.id !== edit.sequence.id || seq.frames !== edit.sequence.frames)) {
    err(`plan was made for another cut (${seq.id}/${seq.frames} vs ${edit.sequence.id}/${edit.sequence.frames}): re-plan, or run gfxresync.mjs`);
  }
  if (!plan || typeof plan.style !== 'string' || !plan.style) err('style is required');
  if (!plan || !isAbs(plan.plate)) err('plate must be an absolute path');
  if (!plan || !isAbs(plan.aep) || !/\.aep$/i.test(plan.aep)) err('aep must be an absolute .aep path');
  const slots = plan && Array.isArray(plan.slots) ? plan.slots : [];
  if (!slots.length) err('slots must be a non-empty array');
  const fps = seq && seq.fps > 0 ? seq.fps : 25;
  const ids = new Set();
  for (const s of slots) {
    const where = `slot ${s && s.id}`;
    if (!s || !ID_RE.test(s.id || '')) { err(`${where}: id must match ${ID_RE} (it names the AE comp and the Premiere item <id>/<aep>)`); continue; }
    if (ids.has(s.id)) err(`${where}: duplicate id`);
    ids.add(s.id);
    const T = TYPES[s.type];
    if (!T) { err(`${where}: unknown type ${s.type}`); continue; }
    if (s.layer !== T.layer) err(`${where}: layer must be ${T.layer} for ${s.type}`);
    if (!isInt(s.in) || !isInt(s.out)) err(`${where}: in/out must be whole frames`);
    else if (!s.lost) {
      if (s.in < 0 || s.out <= s.in || (seq && s.out > seq.frames)) err(`${where}: needs 0 <= in < out <= ${seq && seq.frames}`);
      const min = secToFrames(T.minSec, fps);
      if (s.out - s.in < min) err(`${where}: ${s.out - s.in} frames is shorter than ${min} (${T.minSec} s) for ${s.type}`);
    }
    const text = s.text || {};
    for (const f of T.fields) if (typeof text[f] !== 'string' || !text[f].trim()) err(`${where}: text.${f} is required`);
    for (const [k, v] of Object.entries(text)) {
      if (!T.fields.includes(k) && !T.optional.includes(k)) warnings.push(`${where}: text.${k} is not a field of ${s.type} and is ignored`);
      else if (typeof v !== 'string') err(`${where}: text.${k} must be a string`);
      else if (T.max[k] && v.replace(/\n/g, '').length > T.max[k]) err(`${where}: text.${k} is ${v.length} chars, max ${T.max[k]}`);
    }
    if (s.anchor) {
      const a = s.anchor;
      if (!['words', 'marker', 'time'].includes(a.kind)) err(`${where}: anchor.kind must be words|marker|time`);
      else if (a.kind !== 'time' && (typeof a.text !== 'string' || !a.text.trim())) err(`${where}: anchor.text is required for ${a.kind}`);
      if (!isInt(a.offset || 0)) err(`${where}: anchor.offset must be whole frames`);
    }
  }
  for (const layer of LAYERS) {
    const row = slots.filter((s) => s && !s.lost && s.layer === layer && isInt(s.in) && isInt(s.out)).sort((a, b) => a.in - b.in);
    for (let i = 1; i < row.length; i++) if (row[i].in < row[i - 1].out) err(`slots ${row[i - 1].id} and ${row[i].id} overlap on the ${layer} layer`);
  }
  // «Never within 0.5 s of a cut» (gfx-plan.md): an edge that close makes the graphic twitch with the
  // picture. An insert may sit exactly ON a cut; the logo spans the film and is not checked.
  if (edit) {
    const near = secToFrames(0.5, fps), cuts = cutsOf(edit);
    for (const s of slots) {
      if (!s || s.lost || s.layer === 'logo' || !isInt(s.in) || !isInt(s.out)) continue;
      for (const [edge, f] of [['in', s.in], ['out', s.out]]) {
        const c = cuts.find((x) => Math.abs(x - f) < near && !(s.layer === 'insert' && x === f));
        if (c !== undefined) warnings.push(`slot ${s.id}: ${edge} ${f} is ${Math.abs(f - c)} frames from the cut at ${c}; ${s.layer === 'insert' ? 'put it on the cut' : 'keep 0.5 s clear'}`);
      }
    }
  }
  return { ok: errors.length === 0, errors, warnings };
}

// Where the picture cuts: the edges of the video clips that are not linked graphics, inside the film.
// A through edit (the same media carrying straight on) is not a cut.
export function cutsOf(edit) {
  const set = new Set(), frames = edit.sequence.frames;
  for (const t of edit.videoTracks || []) {
    const cl = (t.clips || []).filter((c) => !/\.aep$/i.test(c.media || '')).sort((a, b) => a.start - b.start);
    cl.forEach((c, i) => {
      const prev = cl[i - 1];
      const through = prev && prev.end === c.start && prev.media === c.media && c.inPoint === prev.inPoint + (prev.end - prev.start);
      if (c.start > 0 && c.start < frames && !through) set.add(c.start);
      if (c.end > 0 && c.end < frames) set.add(c.end);
    });
    // an edge the next clip carries straight on from is not a cut either
    cl.forEach((c, i) => { const nx = cl[i + 1]; if (nx && nx.start === c.end && nx.media === c.media && nx.inPoint === c.inPoint + (c.end - c.start)) set.delete(c.end); });
  }
  return [...set].sort((a, b) => a - b);
}

const clock = (frames, fps) => {
  const s = frames / fps, m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`;
};
const cell = (v) => String(v).replace(/\n/g, ' ').replace(/\|/g, '/');

// The table that goes to the chat for approval: one row per slot.
export function planTable(plan) {
  const fps = plan.sequence.fps;
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
