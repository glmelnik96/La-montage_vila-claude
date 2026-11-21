#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { callBridge } from './lib/prbridge.mjs';
import { loadConfig } from './lib/config.mjs';

function out(obj) { console.log(JSON.stringify(obj, null, 2)); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// The panel reports its timeouts in Russian («ExtendScript не ответил за …»).
const isTimeout = (e) => /timeout|timed out|не ответил/i.test(String((e && e.message) || e));

// The cache is a flat JSON map. Current panel builds key by sequenceID (a UUID);
// older entries are keyed by a normalized sequence name (context-store.js:
// normSeqKey = trim + collapse whitespace). Try the id first, then the name,
// then case-insensitive name, mirroring the panel's findTranscriptEntry.
function normSeqKey(name) { return String(name).trim().replace(/\s+/g, ' '); }

function readTranscriptForActiveSequence(sequenceName, sequenceId) {
  const cfg = loadConfig();
  let raw;
  try { raw = readFileSync(cfg.transcriptCachePath, 'utf8'); }
  catch { return { found: false, reason: 'no_cache_file' }; }
  let obj;
  try { obj = JSON.parse(raw); } catch { return { found: false, reason: 'corrupt_cache' }; }
  let entry = sequenceId ? obj[String(sequenceId)] : undefined;
  const key = normSeqKey(sequenceName);
  if (!entry) entry = obj[key];
  if (!entry) {
    const lower = key.toLowerCase();
    const hit = Object.keys(obj).find((k) => normSeqKey(k).toLowerCase() === lower);
    if (hit) entry = obj[hit];
  }
  if (!entry) return { found: false, reason: 'no_entry_for_sequence', sequenceName, sequenceId };
  return { found: true, entry };
}

// Read a JSON payload either inline (--json '<...>') or from a file (--file path).
// File form is preferred for large plans.
function readPayloadArg(argv) {
  const fileIdx = argv.indexOf('--file');
  if (fileIdx !== -1) return JSON.parse(readFileSync(argv[fileIdx + 1], 'utf8'));
  const jsonIdx = argv.indexOf('--json');
  if (jsonIdx !== -1) return JSON.parse(argv[jsonIdx + 1]);
  throw new Error('Provide --file <path> or --json <string>');
}

function argVal(argv, flag) { const i = argv.indexOf(flag); return i !== -1 ? argv[i + 1] : undefined; }

// Guard a ripple-delete cut plan before applying. A backup exists, but this
// catches obvious mistakes cheaply: each interval must be well-formed and within
// [0, sequenceEndSec], intervals must not overlap, and the edit must leave at
// least minKeepSec of footage. A HIGH removed ratio is expected for highlight
// edits (keep 5 min of 60 → ~0.92 removed), so we report the ratio, never cap it.
function validateCutPlan(ops, seqEndSec, minKeepSec) {
  const intervals = [];
  for (const op of ops) {
    const s = Number(op.startSec), e = Number(op.endSec);
    if (!Number.isFinite(s) || !Number.isFinite(e)) return { ok: false, reason: 'non_numeric_interval', op };
    if (e <= s) return { ok: false, reason: 'empty_or_reversed_interval', op };
    if (s < 0) return { ok: false, reason: 'negative_start', op };
    if (seqEndSec != null && e > seqEndSec + 0.001) return { ok: false, reason: 'interval_past_end', op, seqEndSec };
    intervals.push([s, e]);
  }
  intervals.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < intervals.length; i++) {
    if (intervals[i][0] < intervals[i - 1][1] - 0.001) {
      return { ok: false, reason: 'overlapping_intervals', a: intervals[i - 1], b: intervals[i] };
    }
  }
  const removedSec = intervals.reduce((sum, [s, e]) => sum + (e - s), 0);
  const removedRatio = seqEndSec ? removedSec / seqEndSec : null;
  if (seqEndSec != null) {
    const keptSec = seqEndSec - removedSec;
    if (keptSec < minKeepSec) return { ok: false, reason: 'leaves_too_little_footage', keptSec, minKeepSec, removedSec, removedRatio };
  }
  return { ok: true, removedSec, removedRatio };
}

async function main() {
  const argv = process.argv.slice(2);
  const [cmd] = argv;
  switch (cmd) {
    case 'snapshot': {
      const data = await callBridge('getTimelineSnapshot', []);
      out(data);
      break;
    }
    case 'backup': {
      // Clones the active sequence as «… [бэкап HH:MM:SS]» and REFOCUSES THE ORIGINAL: to work in a
      // copy, clone and activate it yourself (SKILL.md, «Before touching anything»).
      const data = await callBridge('backupActiveSequence', []);
      out(data); // { backupId, backupName, ... }
      break;
    }
    case 'transcribe': {
      // --seq-id <id> / --seq-name <name> read another sequence's entry — the source's, when you
      // work in a clone (a clone has a new sequenceID and no transcript of its own).
      const byId = argVal(argv, '--seq-id'), byName = argVal(argv, '--seq-name');
      const snap = byId || byName ? null : await callBridge('getTimelineSnapshot', []);
      const seqName = byName || (snap && snap.sequenceName) || '';
      if (!seqName && !byId) { out({ ok: false, error: 'No active sequence' }); break; }
      const res = readTranscriptForActiveSequence(seqName, byId || (snap && snap.sequenceId));
      if (!res.found) {
        out({
          ok: false,
          needsTranscription: true,
          sequenceName: seqName,
          reason: res.reason,
          instruction: 'Open the "ИИ: монтаж" panel in Premiere and run transcription once for this sequence, then re-run pr.mjs transcribe.'
        });
        break;
      }
      out({ ok: true, sequenceName: seqName, transcript: res.entry });
      break;
    }
    case 'cut': {
      // payload: { ops: [ { startSec, endSec, mode: "ripple" | "lift" }, ... ] }  (ORIGINAL coordinates)
      // flags: --force (override guard), --min-keep-sec <n> (default 2)
      const plan = readPayloadArg(argv);
      if (!plan || !Array.isArray(plan.ops)) throw new Error('cut payload needs { ops: [...] }');
      const force = argv.includes('--force');
      const minKeepSec = Number(argVal(argv, '--min-keep-sec') ?? 2);
      const snap = await callBridge('getTimelineSnapshot', []);
      const seqEnd = snap && typeof snap.sequenceEndSec === 'number' ? snap.sequenceEndSec : null;
      const check = validateCutPlan(plan.ops, seqEnd, minKeepSec);
      if (!check.ok && !force) {
        out({ ok: false, blocked: true, reason: check.reason, details: check, sequenceEndSec: seqEnd, hint: 'Fix the plan, or pass --force to override.' });
        process.exit(1);
      }
      // Translate the skill's cut contract into the host's applyTimecodeEdits
      // schema. The panel reads plan.operations (NOT plan.ops) and only knows
      // the interval actions ripple_delete_range / lift_delete_range — the
      // legacy "ripple_delete_interval" name is silently ignored (0 ops). Ripple
      // is the default (closes the gap); pass mode:"lift" for a lift-delete.
      // Apply interval deletes in DESCENDING startSec order. Each ripple delete
      // shifts all later content left by its length, so a low-to-high order would
      // make every subsequent interval's coordinates refer to already-shifted
      // footage (deleting the wrong region). Deleting highest-first keeps every
      // remaining interval's original-timeline coordinates valid. (Lift deletes
      // don't shift, so descending is harmless for them too.)
      const hostPlan = {
        expectedSequenceName: snap && snap.sequenceName,
        operations: plan.ops
          .slice()
          .sort((x, y) => Number(y.startSec) - Number(x.startSec))
          .map((o) => ({
            type: o.mode === 'lift' ? 'lift_delete_range' : 'ripple_delete_range',
            startSec: Number(o.startSec),
            endSec: Number(o.endSec),
          })),
      };
      let data;
      try {
        data = await callBridge('applyTimecodeEdits', [hostPlan], { timeoutMs: 130000 });
      } catch (e) {
        if (!isTimeout(e)) throw e;
        // The edit keeps running inside Premiere. Re-issuing it would cut twice: wait until the
        // host answers a read again (ExtendScript is single-threaded, so the edit has finished by
        // then) and compare the new end with the expected one.
        console.error('cut: bridge timeout — the edit is still running in Premiere. NOT re-issuing; polling.');
        const allRipple = plan.ops.every((o) => o.mode !== 'lift');
        const want = seqEnd != null && allRipple ? +(seqEnd - check.removedSec).toFixed(3) : null;
        for (let i = 0; i < 120 && !data; i++) {
          await sleep(15000);
          let s2;
          try { s2 = await callBridge('getTimelineSnapshot', [], { timeoutMs: 40000 }); } catch { continue; }
          const end = s2 && s2.sequenceEndSec;
          data = { ok: want == null || Math.abs(end - want) < 0.1, recoveredAfterTimeout: true, sequenceEndSecAfter: end, expectedEndSec: want };
        }
        if (!data) { out({ ok: false, timeout: true, hint: 'Premiere is still busy after 30 min. Do NOT re-run the cut; check the timeline.' }); process.exit(1); }
      }
      out({ ...data, sequenceEndSec: seqEnd, removedSec: check.removedSec, removedRatio: check.removedRatio, forced: force && !check.ok });
      break;
    }
    case 'markers': {
      // payload: [ { timeSec, name, comment, color }, ... ] — the host key is timeSec (a row without
      // it is skipped silently) and the host ignores color: run markercolors.mjs afterwards
      const markers = readPayloadArg(argv);
      if (!Array.isArray(markers)) throw new Error('markers payload must be an array');
      const data = await callBridge('addSequenceMarkers', [markers], { timeoutMs: 130000 });
      out(data); // { ok, count }
      break;
    }
    case 'reframe-sources': {
      const data = await callBridge('getVerticalReframeSources', []);
      out(data); // { ok, clips:[{trackIndex, clipIndex, name, mediaPath, startSec, endSec, inPointSec}, ...] }
      break;
    }
    case 'reframe': {
      // payload: { newName, targetW, targetH, expectedSequenceName,
      //            items: [ { trackIndex, clipIndex, scalePct, posX, posY }, ... ] }  (build with vframe.mjs)
      // CLONES the active sequence into a vertical one; trim the clone with `cut` afterwards.
      const plan = readPayloadArg(argv);
      const data = await callBridge('applyVerticalReframe', [plan], { timeoutMs: 130000 });
      out(data);
      break;
    }
    case 'overlay': {
      // payload: { filePath, expectedSequenceName, startSec } — both of the first two are required
      const payload = readPayloadArg(argv);
      const data = await callBridge('importAndOverlayOnTop', [payload], { timeoutMs: 130000 });
      out(data);
      break;
    }
    case 'import': {
      // payload: { path, binName? } — the key is `path` here (overlay uses `filePath`)
      const payload = readPayloadArg(argv);
      const data = await callBridge('importMediaFile', [payload], { timeoutMs: 130000 });
      out(data);
      break;
    }
    case 'activate': {
      // --by-id <seqId>  OR  --by-name <name>
      const idIdx = argv.indexOf('--by-id');
      const nameIdx = argv.indexOf('--by-name');
      let data;
      if (idIdx !== -1) data = await callBridge('activateSequenceById', [argv[idIdx + 1]]);
      else if (nameIdx !== -1) data = await callBridge('activateSequenceByName', [{ name: argv[nameIdx + 1] }]);
      else throw new Error('activate needs --by-id <id> or --by-name <name>');
      out(data);
      break;
    }
    default:
      console.error('Usage: pr.mjs <snapshot|backup|transcribe [--seq-id <id>|--seq-name <name>]|cut|markers|reframe-sources|reframe|overlay|import|activate> [--file <payload.json> | --json <payload>]');
      process.exit(2);
  }
}
main().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
