// Lay still images (slides, cards) onto a video track of the active sequence at
// exact ranges. overwriteClip places a still at the preference default length,
// so each one is then trimmed by assigning a whole Time object to `end` —
// `clip.end.seconds = x` is a silent no-op on current builds.
//
//   node scripts/placestills.mjs --seq "<active sequence>" --bin "<bin name>" --track 1 \
//        --items items.json [--batch 10]
//
// items.json: [{ "name": "slide_02.png", "st": 36.28, "en": 73.40 }, ...]  (seconds)
//
// Items go down in time order, so a still's default length can only run into
// empty track, never into one already placed. Re-running is safe: an item whose
// clip already sits at `st` is skipped.
import { readFileSync } from 'node:fs';
import { callBridge } from './lib/prbridge.mjs';

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : d;
};
const items = JSON.parse(readFileSync(arg('items'), 'utf8')).sort((a, b) => a.st - b.st);
const SEQ = arg('seq'), BIN = arg('bin'), TRACK = +arg('track', 1), BATCH = +arg('batch', 10);
if (!SEQ || !BIN) { console.error('usage: placestills.mjs --seq <name> --bin <bin> --track <n> --items <json>'); process.exit(2); }

const jsx = (batch) => `(function(){try{
  var I=${JSON.stringify(batch)}, SEQ=${JSON.stringify(SEQ)}, BIN=${JSON.stringify(BIN)}, TR=${TRACK};
  var s=app.project.activeSequence;
  if(!s||String(s.name)!==SEQ) return JSON.stringify({error:'active sequence is '+(s?s.name:'none')});
  var root=app.project.rootItem,bin=null,i,j;
  for(i=0;i<root.children.numItems;i++){var c=root.children[i];if(c.type===2&&String(c.name)===BIN){bin=c;break;}}
  if(!bin) return JSON.stringify({error:'bin not found: '+BIN});
  var items={}; for(i=0;i<bin.children.numItems;i++) items[String(bin.children[i].name)]=bin.children[i];
  var tr=s.videoTracks[TR], placed=0, skipped=0, bad=[];
  function at(nm,st){for(var k=0;k<tr.clips.numItems;k++){var q=tr.clips[k];
    if(String(q.name)===nm&&Math.abs(q.start.seconds-st)<0.02) return q;} return null;}
  for(j=0;j<I.length;j++){
    var it=I[j], pi=items[it.name];
    if(!pi){bad.push(it.name+': not in bin');continue;}
    var c0=at(it.name,it.st);
    if(!c0){tr.overwriteClip(pi,it.st);c0=at(it.name,it.st);if(!c0){bad.push(it.name+'@'+it.st+': not placed');continue;}placed++;}
    else skipped++;
    var tE=new Time(); tE.seconds=it.en; c0.end=tE;
    if(Math.abs(c0.end.seconds-it.en)>0.02) bad.push(it.name+'@'+it.st+': end '+c0.end.seconds+' != '+it.en);
  }
  return JSON.stringify({placed:placed,skipped:skipped,bad:bad});
}catch(e){return JSON.stringify({error:String(e),line:e.line});}})()`;

let total = 0;
for (let i = 0; i < items.length; i += BATCH) {
  const raw = await callBridge('evalJson', [jsx(items.slice(i, i + BATCH))], { timeoutMs: 120000 });
  const r = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (r.error) { console.error('ERROR', r.error, r.line || ''); process.exit(1); }
  total += r.placed;
  console.error(`  ${i + 1}-${Math.min(i + BATCH, items.length)}/${items.length}: placed ${r.placed}, already there ${r.skipped}` +
    (r.bad.length ? `, PROBLEMS: ${r.bad.join('; ')}` : ''));
  if (r.bad.length) process.exit(1);
}
console.error(`${total} stills placed on V${TRACK + 1}`);
