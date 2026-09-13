// Find tracks whose item list is out of time order — the state `TrackItem.move()` leaves
// when clips are moved past each other (Premiere 26.3). Every DOM position still reads
// right and QE may even render the frames, but the timeline panel draws the track empty
// from the misplaced item on, and `sequence.end` reports the end of the item that is last
// IN THE LIST, not last in time.
//
//   node scripts/trackorder.mjs
//
// Checks every sequence of the active project. Repair: `sequence.clone()` rebuilds every
// track's list in time order and keeps each clip's effects — clone, compare the clone with
// the original, then rename the broken one to `_OLD_…` and the clone to the real name.
import { callBridge } from './lib/prbridge.mjs';

const code = `(function(){try{
  var p=app.project, out=[], i, t;
  function scan(tr, label, acc){ var n=tr.clips.numItems, q, c, prev=-1, inv=0, mx=0;
    for(q=0;q<n;q++){ c=tr.clips[q]; if(c.start.seconds<prev-0.001) inv++; prev=c.start.seconds; if(c.end.seconds>mx) mx=c.end.seconds; }
    if(n) acc.tracks.push(label+' '+n+(inv?' OUT OF ORDER x'+inv:''));
    if(inv) acc.bad++; if(mx>acc.last) acc.last=mx; }
  for(i=0;i<p.sequences.numSequences;i++){ var s=p.sequences[i], acc={tracks:[], bad:0, last:0};
    for(t=0;t<s.videoTracks.numTracks;t++) scan(s.videoTracks[t], 'V'+(t+1), acc);
    for(t=0;t<s.audioTracks.numTracks;t++) scan(s.audioTracks[t], 'A'+(t+1), acc);
    var end=s.end/254016000000;
    out.push({name:String(s.name), end:Math.round(end*100)/100, lastClip:Math.round(acc.last*100)/100,
      broken: acc.bad>0 || Math.abs(end-acc.last)>0.05, tracks:acc.tracks}); }
  return JSON.stringify(out);
}catch(e){return JSON.stringify({error:String(e),line:e.line});}})()`;

const raw = await callBridge('evalJson', [code], { timeoutMs: 30000 });
const r = typeof raw === 'string' ? JSON.parse(raw) : raw;
if (r.error) { console.error(JSON.stringify(r)); process.exit(2); }
for (const s of r) {
  console.log(`${s.broken ? 'BROKEN' : 'ok    '}  ${s.name}  (sequence.end ${s.end}, last clip ${s.lastClip})`);
  if (s.broken) console.log(`        ${s.tracks.join(', ')}`);
}
process.exit(r.some((s) => s.broken) ? 1 : 0);
