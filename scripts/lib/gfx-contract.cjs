// Workflow I plan contract. Shipped with both standalone skills.
const fs = require('node:fs');
const path = require('node:path');

// One row per graphic type. layer: overlay (over the picture), logo (its own track, may span the
// film), insert (full screen, the edit's sound runs under it). fields are required, optional are
// allowed. minSec is the planner's floor; the AE side checks the exact minimum from the template.
// max: characters per field (the template's BOX is the real limit, checked when AE builds).
const TYPES = {
  lower_third: { layer: 'overlay', label: 'плашка', fields: ['name', 'role'], optional: [], minSec: 3, max: { name: 40, role: 60 } },
  quote: { layer: 'overlay', label: 'ключевая мысль', fields: ['quote'], optional: ['author'], minSec: 3.5, max: { quote: 140, author: 60 } },
  callout: { layer: 'overlay', label: 'выноска', fields: ['value'], optional: ['caption'], minSec: 3, max: { value: 24, caption: 60 } },
  logo: { layer: 'logo', label: 'логотип', fields: [], optional: [], minSec: 3, max: {} },
  chapter: { layer: 'insert', label: 'карточка главы', fields: ['title'], optional: ['subtitle', 'number'], minSec: 3, max: { title: 60, subtitle: 80, number: 24 } },
  intro: { layer: 'insert', label: 'заставка', fields: ['title'], optional: ['subtitle'], minSec: 3.5, max: { title: 60, subtitle: 80 } },
  outro: { layer: 'insert', label: 'концовка', fields: ['title'], optional: ['subtitle'], minSec: 3.5, max: { title: 60, subtitle: 80 } },
};
const LAYERS = ['overlay', 'logo', 'insert'];

const secToFrames = (sec, fps) => Math.round(sec * fps);

const ID_RE = /^[A-Z][A-Z0-9_]{1,39}$/;
const isInt = (v) => Number.isInteger(v);
const isAbs = (p) => typeof p === 'string' && /^([A-Za-z]:[\\/]|\/)/.test(p);
const record = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const filled = (v) => typeof v === 'string' && !!v.trim();

// Keys passed through to ExtendScript must also work on ES3 objects.
const fieldKey = (s) => /^[a-zA-Z][a-zA-Z0-9_]*$/.test(s) && !Object.hasOwn(Object.prototype, s);

function kitRoles(kit, style, errors) {
  const roles = new Map();
  if (!record(kit) || kit.version !== 1 || kit.style !== style || !record(kit.roles) || !Object.keys(kit.roles).length) {
    errors.push('kit needs version 1, the plan style and a non-empty roles object');
    return roles;
  }
  for (const [name, role] of Object.entries(kit.roles)) {
    const where = 'kit role ' + name;
    if (!filled(name) || !record(role) || !LAYERS.includes(role.layer) || !filled(role.template) || !record(role.fields)) {
      errors.push(where + ': expected layer, template comp name and fields object');
      continue;
    }
    const fields = [], targets = new Set();
    for (const [key, field] of Object.entries(role.fields)) {
      if (!fieldKey(key) || !record(field) || !filled(field.target) || !fieldKey(field.target) ||
          field.target !== field.target.toLowerCase() || typeof field.required !== 'boolean') {
        errors.push(where + ': field ' + key + ' needs a lowercase TXT_/BOX_ suffix and a boolean required');
        continue;
      }
      if (targets.has(field.target)) errors.push(where + ': duplicate target ' + field.target);
      targets.add(field.target);
      fields.push({ key, target: field.target, required: field.required });
    }
    roles.set(name, { layer: role.layer, template: role.template, fields });
  }
  return roles;
}

function builtinRole(type) {
  const T = TYPES[type];
  return { layer: T.layer, template: 'TPL_' + type, minSec: T.minSec, max: T.max,
    fields: [...T.fields, ...T.optional].map(key => ({ key, target: key, required: T.fields.includes(key) })) };
}

function mapFields(text, role, external, where, errors, warnings) {
  if (!record(text)) {
    errors.push(where + ': text must be a fields object');
    return [];
  }
  const names = new Set(role.fields.map(f => f.key));
  for (const key of Object.keys(text)) {
    if (!names.has(key)) {
      if (external) errors.push(where + ': text.' + key + ' has no mapping for this visual role');
      else warnings.push(where + ': text.' + key + ' is not a field of this type and is ignored');
    }
  }
  return role.fields.map(field => {
    const { key } = field;
    const value = Object.hasOwn(text, key) ? text[key] : '';
    if (field.required && !filled(value)) errors.push(where + ': text.' + key + ' is required');
    else if (typeof value !== 'string') errors.push(where + ': text.' + key + ' must be a string');
    else if (role.max?.[key] && value.replace(/\n/g, '').length > role.max[key]) {
      errors.push(where + ': text.' + key + ' is ' + value.length + ' chars, max ' + role.max[key]);
    }
    return { ...field, value };
  });
}

// With edit.json the report also checks cut identity and distance to nearby cuts.
function inspectData(plan, kit, edit) {
  const errors = [], warnings = [], mappings = [];
  const err = (m) => errors.push(m);
  if (!plan || plan.version !== 1) err('version must be 1');
  const seq = plan && plan.sequence;
  if (!seq || !Number.isFinite(seq.fps) || seq.fps <= 0 || ![seq.frames, seq.w, seq.h].every(n => isInt(n) && n > 0)) err('sequence needs fps > 0 and positive whole frames, w, h');
  else if (Math.abs(seq.w / seq.h - 16 / 9) > 0.01) err('only 16:9 in v1');
  if (edit && !record(edit.sequence)) err('edit needs sequence metadata');
  else if (edit && seq && (seq.id !== edit.sequence.id || seq.frames !== edit.sequence.frames)) {
    err(`plan was made for another cut (${seq.id}/${seq.frames} vs ${edit.sequence.id}/${edit.sequence.frames}): re-plan, or run gfxresync.mjs`);
  }
  const external = !!plan && Object.hasOwn(plan, 'kit');
  if (external && (!filled(seq?.id) || !filled(seq?.name))) err('a client plan needs sequence.id and sequence.name');
  if (!filled(plan?.style)) err('style is required');
  if (external && plan.style === 'cloudru') err('cloudru is the built-in style; choose a separate style for the client kit');
  if (!external && plan?.style && plan.style !== 'cloudru') err('style ' + plan.style + ' needs a local kit registry (plan.kit)');
  const roles = external ? kitRoles(kit, plan.style, errors) : null;
  if (!plan || !isAbs(plan.plate)) err('plate must be an absolute path');
  if (!plan || !isAbs(plan.aep) || !/\.aep$/i.test(plan.aep)) err('aep must be an absolute .aep path');
  const slots = plan && Array.isArray(plan.slots) ? plan.slots : [];
  if (!slots.length) err('slots must be a non-empty array');
  const fps = seq && seq.fps > 0 ? seq.fps : 25;
  const ids = new Set();
  for (const s of slots) {
    const where = `slot ${s && s.id}`;
    if (!s || typeof s.id !== 'string' || !ID_RE.test(s.id)) { err(`${where}: id must match ${ID_RE} (it names the AE comp and the Premiere item <id>/<aep>)`); continue; }
    if (ids.has(s.id)) err(`${where}: duplicate id`);
    ids.add(s.id);
    if (typeof s.type !== 'string' || !Object.hasOwn(TYPES, s.type)) { err(`${where}: unknown type ${s.type}`); continue; }
    const visualRole = external ? s.visualRole : s.type;
    const role = external ? roles.get(visualRole) : builtinRole(s.type);
    if (!role) { err(`${where}: unknown visual role ${visualRole}`); continue; }
    if (!external && s.visualRole !== undefined && s.visualRole !== s.type) err(where + ': a custom visualRole needs a local kit');
    if (s.layer !== role.layer) err(`${where}: layer must be ${role.layer} for ${visualRole}`);
    if (!isInt(s.in) || !isInt(s.out)) err(`${where}: in/out must be whole frames`);
    else if (!s.lost) {
      if (s.in < 0 || s.out <= s.in || (seq && s.out > seq.frames)) err(`${where}: needs 0 <= in < out <= ${seq && seq.frames}`);
      if (role.minSec) {
        const min = secToFrames(role.minSec, fps);
        if (s.out - s.in < min) err(`${where}: ${s.out - s.in} frames is shorter than ${min} (${role.minSec} s) for ${s.type}`);
      }
    }
    const fields = mapFields(s.text ?? {}, role, external, where, errors, warnings);
    if (!s.lost) mappings.push({ id: s.id, type: s.type, layer: s.layer, visualRole, template: role.template, fields });
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
  if (edit?.sequence) {
    const near = secToFrames(0.5, fps), cuts = cutsOf(edit);
    for (const s of slots) {
      if (!s || s.lost || s.layer === 'logo' || !isInt(s.in) || !isInt(s.out)) continue;
      for (const [edge, f] of [['in', s.in], ['out', s.out]]) {
        const c = cuts.find((x) => Math.abs(x - f) < near && !(s.layer === 'insert' && x === f));
        if (c !== undefined) warnings.push(`slot ${s.id}: ${edge} ${f} is ${Math.abs(f - c)} frames from the cut at ${c}; ${s.layer === 'insert' ? 'put it on the cut' : 'keep 0.5 s clear'}`);
      }
    }
  }
  return { ok: errors.length === 0, errors, warnings, mappings };
}

// A relative registry follows its plan even when the two CLIs have different working directories.
// Reading the mapping never opens the AEP, the plate, or a remote location.
function inspectPlan(plan, planPath, edit) {
  if (!plan || !Object.hasOwn(plan, 'kit')) return inspectData(plan, undefined, edit);
  const file = plan.kit;
  const scheme = /^[a-z][\w+.-]*:/i, drive = /^[a-z]:[\\/]/i;
  if (!filled(file) || /^[\\/]{2}/.test(file) || (scheme.test(file) && !drive.test(file))) {
    return { ok: false, errors: ['kit: expected a local kit JSON path'], warnings: [], mappings: [] };
  }
  let kit;
  try {
    const resolved = path.resolve(path.dirname(planPath), file);
    kit = JSON.parse(fs.readFileSync(resolved, 'utf8').replace(/^\uFEFF/, ''));
  } catch (e) {
    return { ok: false, errors: ['kit: ' + e.message], warnings: [], mappings: [] };
  }
  return inspectData(plan, kit, edit);
}

function selectMappings(report, only) {
  if (only === undefined) return report;
  const ids = new Set(only.split(',').map(x => x.trim()));
  const mappings = report.mappings.filter(m => ids.has(m.id));
  const errors = [...report.errors];
  for (const id of ids) {
    if (!mappings.some(m => m.id === id)) errors.push('--only: no active mapping for ' + JSON.stringify(id));
  }
  return { ...report, mappings, errors, ok: errors.length === 0 };
}

// Where the picture cuts: the edges of the video clips that are not linked graphics, inside the film.
// A through edit (the same media carrying straight on) is not a cut.
function cutsOf(edit) {
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

module.exports = { inspectPlan, inspectData, selectMappings, TYPES, LAYERS, secToFrames, cutsOf };
