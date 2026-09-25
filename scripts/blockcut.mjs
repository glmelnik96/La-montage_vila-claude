// Turn a block plan into one sequence per block, leaving the source untouched.
//
//   node scripts/blockcut.mjs --plan gen-out/slides/m5_plan.snapped.json \
//       [--only 3,7] [--dry-run] [--markers-only]
//
// --markers-only skips cloning and cutting and just (re)places the markers on the
// sequences a previous run already created, found by name.
//
// Each block becomes a CLONE of the source sequence with everything outside its
// keep-intervals ripple-deleted. Cloning rather than cutting the original is the
// whole point: the source sequences are the only copy of the scene-detect edit,
// and a ripple delete cannot be undone programmatically.
//
// Two things that will bite if changed:
//
// * Ripple deletes are applied HIGHEST-FIRST. Each one shifts later content left
//   by its own length, so a low-to-high order would make every later interval's
//   coordinates point at already-shifted footage.
// * Marker times are in SOURCE time in the plan but must be written in the
//   CLONE's time, which is source time minus everything removed before them.
//
// Premiere's bridge times out at 120 s while the edit keeps running inside the
// host, so a timeout here is not a failure — the driver re-reads the sequence
// length to find out what actually happened.
import { readFileSync } from 'node:fs';
import { callBridge } from './lib/prbridge.mjs';

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : d;
};
const has = (k) => process.argv.includes(`--${k}`);

const plan = JSON.parse(readFileSync(arg('plan'), 'utf8'));
const only = arg('only') ? new Set(String(arg('only')).split(',').map(Number)) : null;
const dry = has('dry-run');
const markersOnly = has('markers-only');
const log = (...a) => console.log(...a);
const isTimeout = (e) => /timeout|timed out|не ответил/i.test(String((e && e.message) || e));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// A read after a long ripple queues behind the edit and can time out itself: wait for the host.
async function snapshotWhenFree() {
  for (let i = 0; i < 120; i++) {
    try { return await callBridge('getTimelineSnapshot', [], { timeoutMs: 40000 }); }
    catch (e) { if (!isTimeout(e)) throw e; log('    (host still busy, waiting)'); await sleep(15000); }
  }
  throw new Error('host busy for 30 min');
}

// Everything the clone must lose: the gaps between keep-intervals, plus the head
// and the tail.
function complement(keep, endSec) {
  const iv = keep.slice().sort((a, b) => a[0] - b[0]);
  const out = [];
  let cur = 0;
  for (const [s, e] of iv) {
    if (s > cur + 0.001) out.push([cur, s]);
    cur = Math.max(cur, e);
  }
  if (endSec > cur + 0.001) out.push([cur, endSec]);
  return out;
}

// How much footage before `t` is gone. Partial overlap counts: the interval that
// removes the source's head usually ENDS after the marker, and ignoring it would
// leave the marker at its source time, far past the end of the clone.
const shiftFor = (removed, t) =>
  removed.reduce((n, [s, e]) => n + Math.max(0, Math.min(e, t) - Math.min(s, t)), 0);

async function run() {
  // Must come from the plan. getTimelineSnapshot reports whatever sequence is
  // ACTIVE, which is not necessarily the source — and a too-short endSec silently
  // leaves the source's tail glued onto every clone.
  const endSec = plan.sequenceEndSec;
  if (!endSec) throw new Error('plan is missing sequenceEndSec (length of the source sequence)');
  log(`source "${plan.sequenceName}" end=${endSec}s, ${plan.blocks.length} blocks`);

  for (const b of plan.blocks) {
    if (only && !only.has(b.n)) continue;
    const name = `${plan.module}_${String(b.n).padStart(2, '0')}_${b.title}`;
    const removed = complement(b.keep, endSec);
    const kept = b.keep.reduce((n, [s, e]) => n + (e - s), 0);
    log(`\n[${b.n}] ${name}\n    keep ${JSON.stringify(b.keep)} = ${kept.toFixed(1)}s, ` +
        `${removed.length} deletes`);
    if (dry) continue;

    // Repair pass: the sequences already exist, only the markers are missing.
    if (markersOnly) {
      if (!b.marker) continue;
      const act = await callBridge('evalJson', [activateByName(name)], { timeoutMs: 60000 });
      if (!act || !act.ok) { log('    ACTIVATE FAILED', JSON.stringify(act)); continue; }
      log(`    ${await placeMarker(b, removed)}`);
      continue;
    }

    // a re-run must not clone a block twice: an existing sequence of that name is left alone
    const jsx = `(function(){try{
      var seqs=app.project.sequences,src=null,i,j,k;
      for(i=0;i<seqs.numSequences;i++){if(String(seqs[i].name)===${JSON.stringify(name)})return JSON.stringify({ok:false,exists:true});}
      for(i=0;i<seqs.numSequences;i++){if(String(seqs[i].sequenceID)===${JSON.stringify(plan.sequenceId)}){src=seqs[i];break;}}
      if(!src)return JSON.stringify({ok:false,error:'source not found'});
      var before={};
      for(j=0;j<seqs.numSequences;j++){before[String(seqs[j].sequenceID)]=1;}
      src.clone();
      seqs=app.project.sequences;var made=null;
      for(k=0;k<seqs.numSequences;k++){if(!before[String(seqs[k].sequenceID)]){made=seqs[k];break;}}
      if(!made)return JSON.stringify({ok:false,error:'clone produced nothing'});
      made.name=${JSON.stringify(name)};
      app.project.activeSequence=made;
      return JSON.stringify({ok:true,id:String(made.sequenceID),name:String(made.name)});
    }catch(e){return JSON.stringify({ok:false,error:String(e)});}})()`;

    const made = await callBridge('evalJson', [jsx], { timeoutMs: 120000 });
    if (made && made.exists) { log('    exists — skipped (rename or delete it to rebuild this block)'); continue; }
    if (!made || !made.ok) { log('    CLONE FAILED', JSON.stringify(made)); continue; }
    log(`    clone ${made.id}`);

    const hostPlan = {
      expectedSequenceName: name,
      operations: removed
        .slice()
        .sort((x, y) => y[0] - x[0])
        .map(([s, e]) => ({ type: 'ripple_delete_range', startSec: s, endSec: e }))
    };
    let res;
    try {
      res = await callBridge('applyTimecodeEdits', [hostPlan], { timeoutMs: 130000 });
    } catch (e) {
      if (!isTimeout(e)) throw e;
      log('    (bridge timeout — edit still running, verifying by length)');
      res = null;
    }
    const after = await snapshotWhenFree();
    const gotSec = after && after.sequenceEndSec;
    const drift = gotSec != null ? gotSec - kept : null;
    log(`    cut -> ${gotSec}s (expected ${kept.toFixed(1)}s, drift ${drift?.toFixed(2)}s)` +
        (res && res.ok === false ? ' HOST: ' + res.error : ''));

    if (b.marker) log(`    ${await placeMarker(b, removed)}`);
  }
}

async function placeMarker(b, removed) {
  const at = Math.max(0, b.marker.at - shiftFor(removed, b.marker.at));
  const m = await callBridge('addSequenceMarkers',
    // the host reads `timeSec`; `startSec` is silently rejected
    [[{ timeSec: at, name: b.marker.name, comment: b.marker.comment, color: 1 }]],
    { timeoutMs: 60000 });
  return `marker @${at.toFixed(1)}s ok=${m && m.count === 1}` +
    (m && m.failedCount ? ' ' + JSON.stringify(m.failed) : '');
}

const activateByName = (name) => `(function(){try{
  var seqs=app.project.sequences,i;
  for(i=0;i<seqs.numSequences;i++){if(String(seqs[i].name)===${JSON.stringify(name)}){
    app.project.activeSequence=seqs[i];
    return JSON.stringify({ok:true,id:String(seqs[i].sequenceID)});}}
  return JSON.stringify({ok:false,error:'not found'});
}catch(e){return JSON.stringify({ok:false,error:String(e)});}})()`;

run().then(() => { if (!dry) log('\nThe host ignores marker colour: run markercolors.mjs on the СПОРНО markers.'); })
  .catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
