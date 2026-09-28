// Dump the focused project's sequences: every track item (name, start, end, in, out, media path,
// nodeId), markers, In/Out. Read-only. The JSON is what gradexml.mjs plans from and what the
// replace/substitute tools compare against.
//   node scripts/seqdump.mjs --out <file.json> [--seqs "Ролик 1,Ролик 2"]
import { writeFileSync } from 'node:fs';
import { callBridge } from './lib/prbridge.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const OUT = arg('out'), WANT = arg('seqs') ? arg('seqs').split(',') : null;
if (!OUT) { console.error('usage: dump.mjs --out <file> [--seqs a,b]'); process.exit(2); }

const jsx = `(function(){ try {
  function R(x){ return Math.round(x*1000)/1000; }
  var p=app.project, out={project:String(p.path), active:(p.activeSequence?String(p.activeSequence.name):null), seqs:[], bins:[]}, i, t, q, c, s, k;
  for(i=0;i<p.rootItem.children.numItems;i++){ var b=p.rootItem.children[i]; out.bins.push([String(b.name), b.type, (b.type===2?b.children.numItems:0)]); }
  var want=${JSON.stringify(WANT)};
  for(i=0;i<p.sequences.numSequences;i++){ s=p.sequences[i]; var nm=String(s.name);
    var ok=!want; if(want){ for(k=0;k<want.length;k++){ if(want[k]===nm) ok=true; } }
    var rec={name:nm, id:String(s.sequenceID), end:R(Number(s.end)/254016000000), inP:parseFloat(s.getInPoint()), outP:parseFloat(s.getOutPoint())};
    if(ok){
      rec.v=[]; rec.a=[]; rec.markers=[];
      for(t=0;t<s.videoTracks.numTracks;t++){ var tr=s.videoTracks[t], L=[];
        for(q=0;q<tr.clips.numItems;q++){ c=tr.clips[q]; var mp=''; try{ mp=String(c.projectItem.getMediaPath()); }catch(e1){}
          L.push([String(c.name), R(c.start.seconds), R(c.end.seconds), R(c.inPoint.seconds), R(c.outPoint.seconds), mp, String(c.nodeId)]); }
        rec.v.push(L); }
      for(t=0;t<s.audioTracks.numTracks;t++){ var ta=s.audioTracks[t], A=[];
        for(q=0;q<ta.clips.numItems;q++){ c=ta.clips[q];
          A.push([String(c.name), R(c.start.seconds), R(c.end.seconds), R(c.inPoint.seconds), R(c.outPoint.seconds), '', String(c.nodeId)]); }
        rec.a.push(A); }
      var m=s.markers, mk=m.getFirstMarker(), n=0;
      while(mk && n<2000){ var col=-1; try{ col=mk.getColorByIndex(); }catch(e2){}
        rec.markers.push([R(mk.start.seconds), R(mk.end.seconds), String(mk.name), String(mk.comments), col]); n++; mk=m.getNextMarker(mk); }
    }
    out.seqs.push(rec);
  }
  return JSON.stringify(out);
} catch(e){ return JSON.stringify({error:String(e), line:e.line}); } })()`;

const raw = await callBridge('evalJson', [jsx], { mutating: false, timeoutMs: 90000 });
const r = typeof raw === 'string' ? JSON.parse(raw) : raw;
if (r.error) { console.error(JSON.stringify(r)); process.exit(1); }
writeFileSync(OUT, JSON.stringify(r, null, 1));
console.log(`project ${r.project}\nactive: ${r.active}\nbins: ${r.bins.map((b) => b[0] + (b[1] === 2 ? ` (${b[2]})` : '')).join(' | ')}`);
for (const s of r.seqs) {
  const det = s.v ? `  V: ${s.v.map((L) => L.length).join('/')}  A: ${s.a.map((L) => L.length).join('/')}  markers ${s.markers.length}` : '';
  console.log(`  ${s.name}  [${s.id.slice(0, 8)}]  end ${s.end}  in/out ${s.inP}/${s.outP}${det}`);
}
