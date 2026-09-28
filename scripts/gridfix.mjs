// Put every item edge of the given sequences back on the frame grid, in ticks.
//   node scripts/gridfix.mjs --expect <path part of the focused project> --seqs "Ролик 1,Ролик 5" [--fix]
// Why: a Time built from seconds rounds, and moves by a seconds delta left items 1 tick past the
// grid (ripplecut before 2026-09-28). No DOM read shows it, but the frame at such an edge shows the
// previous item — a slide switch or a cut one frame late — and material later overwritten on the
// grid leaves a 1-tick sliver of the old clip behind. Run it after any scripted move, and before
// placing material over an edit.
// Without --fix it only lists: items shorter than a frame (slivers) and edges off the grid.
// With --fix, per track in ascending order: a sliver shorter than half a frame is removed (lift);
// an item whose start is off the grid is moved by the difference (move() takes a Time delta in
// ticks; it does not drag the linked partner, and every track is walked on its own); an end still
// off the grid afterwards is set in ticks (outPoint first for A/V items, then end).
// Edges are only moved by less than half a frame, never past a neighbour.
import { callBridge } from './lib/prbridge.mjs';
const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
const EXPECT = arg('expect'), SEQS = arg('seqs').split(','), FIX = process.argv.includes('--fix');
const raw = await callBridge('evalJson', [`(function(){try{var p=app.project,k,t,q;
  if(String(p.path).indexOf(${JSON.stringify(EXPECT)})<0) return JSON.stringify({error:'focused project is '+p.path});
  var W=${JSON.stringify(SEQS)}, FIX=${FIX ? 'true' : 'false'}, out={};
  function seqNamed(nm){ for(var j=0;j<p.sequences.numSequences;j++){ if(String(p.sequences[j].name)===nm) return p.sequences[j]; } return null; }
  for(k=0;k<W.length;k++){ var s=seqNamed(W[k]); if(!s){ out[W[k]]={error:'no sequence'}; continue; }
    var st=s.getSettings(), TPF=Math.round(254016000000*Number(st.videoFrameRate.seconds));
    var rows=[], fixed=0, removed=0;
    var groups=[]; for(t=0;t<s.videoTracks.numTracks;t++) groups.push(['V'+(t+1), s.videoTracks[t], true]);
    for(t=0;t<s.audioTracks.numTracks;t++) groups.push(['A'+(t+1), s.audioTracks[t], false]);
    for(var g=0;g<groups.length;g++){ var tr=groups[g][1], still;
      for(q=0;q<tr.clips.numItems;q++){ var c=tr.clips[q], a=Number(c.start.ticks), b=Number(c.end.ticks);
        var ra=a%TPF, rb=b%TPF; if(ra>TPF/2) ra-=TPF; if(rb>TPF/2) rb-=TPF;
        if(b-a<TPF/2){ rows.push(groups[g][0]+' SLIVER '+String(c.name).slice(0,30)+' @'+(Math.round(a/TPF))+'f len '+(b-a)+' ticks');
          if(FIX){ c.remove(false,true); removed++; q--; } continue; }
        if(ra===0 && rb===0) continue;
        rows.push(groups[g][0]+' '+String(c.name).slice(0,30)+' @'+Math.round(a/TPF)+'f start'+(ra>=0?'+':'')+ra+' end'+(rb>=0?'+':'')+rb);
        if(!FIX) continue;
        if(ra!==0){ var d=new Time(); d.ticks=String(-ra); c.move(d); }
        var b2=Number(c.end.ticks), rb2=b2%TPF; if(rb2>TPF/2) rb2-=TPF;
        if(rb2!==0){ var te=new Time(); te.ticks=String(b2-rb2);
          still=/[.](png|jpe?g|psd|tiff?)$/i.test(String(c.name));
          if(!still){ var to=new Time(); to.ticks=String(Number(c.outPoint.ticks)-rb2); c.outPoint=to; }
          c.end=te; }
        fixed++; } }
    var left=0; for(var g2=0;g2<groups.length;g2++){ var tr2=groups[g2][1]; for(q=0;q<tr2.clips.numItems;q++){ var c2=tr2.clips[q], a2=Number(c2.start.ticks), b3=Number(c2.end.ticks);
      if(a2%TPF!==0 || b3%TPF!==0 || b3-a2<TPF) left++; } }
    out[W[k]]={tpf:TPF, found:rows, fixed:fixed, removed:removed, offGridLeft:left, end:Number(s.end)/TPF}; }
  return JSON.stringify(out);
}catch(e){return JSON.stringify({error:String(e),line:e.line});}})()`], { timeoutMs: 110000, mutating: FIX });
const r = typeof raw === 'string' ? JSON.parse(raw) : raw;
if (r.error) { console.error(r); process.exit(1); }
let bad = 0;
for (const [name, x] of Object.entries(r)) {
  if (x.error) { console.log(name, x.error); bad++; continue; }
  console.log(`${name}: ${x.found.length} off-grid or sliver items${FIX ? `, fixed ${x.fixed}, removed ${x.removed}` : ''}; left off the grid: ${x.offGridLeft}; end ${x.end} frames`);
  for (const row of x.found.slice(0, 40)) console.log('   ' + row);
  bad += FIX ? x.offGridLeft : 0;
}
if (bad) process.exit(1);
