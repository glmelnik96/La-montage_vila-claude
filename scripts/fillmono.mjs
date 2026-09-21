// A shoot where the lav went into ONE input leaves the voice on a single channel: the timeline
// plays it out of one speaker. This copies that channel onto both, per clip, with the host's own
// audio effect — «Fill Left with Right» (or its mirror), added through QE.
//
//   node scripts/fillmono.mjs --seq "<active sequence>" [--track 0] [--from right] [--match .MOV]
//        [--after <sec>] [--batch 25]
//
// --from right   the voice sits on the RIGHT channel  -> «Fill Left with Right»  (default)
// --from left    the voice sits on the LEFT channel   -> «Fill Right with Left»
// --match        only clips whose name ends with this (case-insensitive); leave out for all
//
// Batches walk an INDEX WINDOW, not a "does it have the effect already" test: QE serves a cached
// track item list, so a component count read right after adding one still reports the old value
// and the same clip collects the effect two or three times. Stacking it is harmless (L := R twice
// is L := R) but it is untidy; the window keeps every clip to exactly one.
// Check the source first — `ffmpeg -i clip -af astats -f null -` prints the RMS of each channel;
// a silent channel reads about -65 dB against -20 dB on the other one.
import { callBridge } from './lib/prbridge.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const SEQ = arg('seq'), TRACK = +arg('track', 0), B = +arg('batch', 25), MATCH = arg('match', '');
const AFTER = +arg('after', -1);          // only clips starting at or after this second
const FX = arg('from', 'right') === 'left' ? 'Fill Right with Left' : 'Fill Left with Right';
if (!SEQ) { console.error('usage: fillmono.mjs --seq "<name>" [--from right|left] [--match .MOV]'); process.exit(2); }

const isTimeout = (e) => /timeout|timed out|не ответил/i.test(String(e));
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const code = (from) => `(function(){try{
  app.enableQE();
  var s=app.project.activeSequence;
  if(!s || String(s.name)!==${JSON.stringify(SEQ)}) return JSON.stringify({error:'active is '+(s?s.name:'none')});
  var q=qe.project.getActiveSequence(), t=q.getAudioTrackAt(${TRACK});
  var fx=qe.project.getAudioEffectByName(${JSON.stringify(FX)});
  if(!fx || !String(fx.name).length) return JSON.stringify({error:'no audio effect ${FX}'});
  var done=0, seen=0, i, m=${JSON.stringify(MATCH)}.toLowerCase();
  for(i=0;i<t.numItems;i++){
    var it=t.getItemAt(i);
    if(String(it.type)!=='Clip') continue;
    var nm=String(it.name).toLowerCase();
    if(m.length && nm.substr(nm.length-m.length)!==m) continue;
    if(${AFTER}>=0 && it.start.secs<${AFTER}) continue;
    seen++;
    if(seen<=${from} || done>=${B}) continue;   // an index window: QE's component count lags behind
    it.addAudioEffect(fx); done++;
  }
  return JSON.stringify({done:done, matched:seen});
}catch(e){return JSON.stringify({error:String(e),line:e.line});}})()`;

let from = 0;
for (let pass = 1; pass <= 200; pass++) {
  let r;
  try {
    const raw = await callBridge('evalJson', [code(from)], { timeoutMs: 30000 });
    r = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (e) {
    if (isTimeout(e)) { console.error('  bridge timeout, re-checking'); await pause(8000); continue; }
    throw e;
  }
  if (r.error) { console.error(JSON.stringify(r)); process.exit(2); }
  from += r.done;
  console.error(`  pass ${pass}: ${FX} on ${r.done} clips, ${from}/${r.matched}`);
  if (from >= r.matched || r.done === 0) { console.log(JSON.stringify({ effect: FX, applied: from, matched: r.matched })); break; }
}
