// Build a sequence by INSERTING source ranges in time order — no TrackItem.move().
//
// Why: rearrange.mjs parks every piece past the end and moves it back one by one. On
// Premiere 26.3 the scripting layer then reports every clip where it belongs, but the
// track's own item list stays in the ORIGINAL order: the timeline panel draws the
// canvas empty, the renderer returns frames with no video for some pieces, and
// sequence.end reports the end of the clip that used to be last. Numbers from the DOM
// all pass; only a rendered frame shows it. Inserting in ascending time builds the
// list in order.
//
//   node scripts/assemble.mjs --plan expected.json --src "<source seq>" --seq "<new seq>" --step <step>
//        [--only C17,C02] [--batch 8]
//   steps: prepare  clone the source sequence under --seq (settings identical), activate it
//          empty    remove every clip from the new sequence, in batches
//          place    overwrite each planned piece at its target (ascending), verify, trim
//          check    list what sits on V1/A1 of the new sequence
//
// expected.json: [{clip, ns, ne, sIn, label, role}, ...] — clip = index of the piece's
// clip on V1 of the source sequence, whose projectItem supplies the media. The project
// item's in/out marks are set for each overwrite and cleared right after.
import { readFileSync } from 'node:fs';
import { callBridge } from './lib/prbridge.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const SRC = arg('src'), SEQ = arg('seq'), STEP = arg('step'), B = +arg('batch', 8);
const only = arg('only') ? new Set(arg('only').split(',')) : null;
let plan = arg('plan') ? JSON.parse(readFileSync(arg('plan'), 'utf8')) : [];
if (only) plan = plan.filter((r) => only.has(r.label));
// t = video track index (0 = V1; its audio lands on the same-index audio track by itself),
// sc = scale the placed video to the frame (720p vlog footage on a 1080p sequence)
plan = plan.map((r) => ({ c: r.clip, ns: r.ns, ne: r.ne, i: r.sIn, o: +(r.sIn + (r.ne - r.ns)).toFixed(3), l: r.label,
  t: r.tr || 0, sc: +r.sc || 0 }))            // sc is the Scale percentage itself (150), not a flag
  .sort((a, b) => a.t - b.t || a.ns - b.ns);

const isTimeout = (e) => /timeout|timed out|не ответил/i.test(String(e));
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function run(body) {
  const code = `(function(){try{var p=app.project,i,S=null,N=null;
    for(i=0;i<p.sequences.numSequences;i++){var q=p.sequences[i];if(String(q.name)===${JSON.stringify(SRC)})S=q;if(String(q.name)===${JSON.stringify(SEQ)})N=q;}
    function R(x){return Math.round(x*1000)/1000;}
    ${body}
  }catch(e){return JSON.stringify({error:String(e),line:e.line});}})()`;
  const raw = await callBridge('evalJson', [code], { timeoutMs: 30000 });
  const r = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (r && r.error) throw new Error(JSON.stringify(r));
  return r;
}
async function loop(body, label) {
  for (let pass = 1; pass <= 400; pass++) {
    let r;
    try { r = await run(body); } catch (e) {
      if (isTimeout(e)) { console.error(`  ${label}: bridge timeout, re-checking`); await pause(8000); continue; }
      throw e;
    }
    console.error(`  ${label} pass ${pass}: done ${r.done}, remaining ${r.remaining}${r.note ? ' ' + JSON.stringify(r.note) : ''}`);
    if (r.remaining === 0) return r;
    if (r.done === 0) throw new Error(`${label} stalled: ${JSON.stringify(r)}`);
  }
  throw new Error(`${label}: did not converge`);
}

const BODY = {
  prepare: `
    if(!S) return JSON.stringify({error:'no source sequence'});
    if(!N){ var before={}; for(i=0;i<p.sequences.numSequences;i++) before[String(p.sequences[i].sequenceID)]=1;
      S.clone(); for(i=0;i<p.sequences.numSequences;i++){ var r=p.sequences[i]; if(!before[String(r.sequenceID)]) N=r; }
      if(!N) return JSON.stringify({error:'clone not found'}); N.name=${JSON.stringify(SEQ)}; }
    p.openSequence(N.sequenceID); var s=p.activeSequence;
    return JSON.stringify({active:String(s.name), id:String(N.sequenceID), v1:s.videoTracks[0].clips.numItems, a1:s.audioTracks[0].clips.numItems});`,
  empty: `
    var s=p.activeSequence; if(String(s.name)!==${JSON.stringify(SEQ)}) return JSON.stringify({error:'active is '+s.name});
    var n=0,t,tr;
    for(t=0;t<s.videoTracks.numTracks&&n<${B * 4};t++){tr=s.videoTracks[t];while(tr.clips.numItems>0&&n<${B * 4}){tr.clips[tr.clips.numItems-1].remove(0,1);n++;}}
    for(t=0;t<s.audioTracks.numTracks&&n<${B * 4};t++){tr=s.audioTracks[t];while(tr.clips.numItems>0&&n<${B * 4}){tr.clips[tr.clips.numItems-1].remove(0,1);n++;}}
    var rem=0; for(t=0;t<s.videoTracks.numTracks;t++) rem+=s.videoTracks[t].clips.numItems; for(t=0;t<s.audioTracks.numTracks;t++) rem+=s.audioTracks[t].clips.numItems;
    return JSON.stringify({done:n,remaining:rem});`,
  place: `
    var P=${JSON.stringify(plan)}, s=p.activeSequence; if(String(s.name)!==${JSON.stringify(SEQ)}) return JSON.stringify({error:'active is '+s.name});
    var SV=S.videoTracks[0], n=0, k, j, note=[], V, A;
    function at(tr,t0){for(var q=0;q<tr.clips.numItems;q++){if(Math.abs(tr.clips[q].start.seconds-t0)<0.02) return tr.clips[q];}return null;}
    function tm(x){var t=new Time();t.seconds=x;return t;}
    var rem=0;
    for(k=0;k<P.length;k++){ var e=P[k]; V=s.videoTracks[e.t]; A=s.audioTracks[e.t];
      var v=at(V,e.ns), src=SV.clips[e.c], pi=src.projectItem;
      // a still reports its default source range 3599.96-3604.96: no in-point to compare, no audio
      var still=Math.abs(src.inPoint.seconds-3600)<0.1;
      // a 30 fps source reports its in-point on its own 1/30 s grid: allow a frame and a half,
      // or a placed vlog piece never counts as done and is overwritten on every pass
      if(v && String(v.name)===String(src.name) && (still || Math.abs(v.inPoint.seconds-e.i)<0.05) && Math.abs(v.end.seconds-e.ne)<0.05) continue;
      if(n>=${B}){rem++;continue;}
      if(!still){ pi.setInPoint(e.i,4); pi.setOutPoint(e.o,4); }
      V.overwriteClip(pi,e.ns);
      if(!still){ try{pi.clearInPoint();pi.clearOutPoint();}catch(e1){ pi.setInPoint(0,4); } }
      v=at(V,e.ns);
      if(!v){ note.push(e.l+' not placed'); n++; continue; }
      if(Math.abs(v.end.seconds-e.ne)>=0.02){ if(!still){ v.outPoint=tm(e.i+(e.ne-e.ns)); } v.end=tm(e.ne); }
      // no setScaleToFrameSize on this build: set Motion > Scale (properties[1]) to e.sc percent
      if(e.sc){ try{ var mo=null,q2; for(q2=0;q2<v.components.numItems;q2++){ if(String(v.components[q2].matchName)==='AE.ADBE Motion') mo=v.components[q2]; }
        if(mo) mo.properties[1].setValue(e.sc,true); else note.push(e.l+' no Motion'); }catch(eS){ note.push(e.l+' scale: '+eS); } }
      var a=at(A,e.ns);
      if(!still && a && Math.abs(a.end.seconds-e.ne)>=0.02){ a.outPoint=tm(e.i+(e.ne-e.ns)); a.end=tm(e.ne); }
      if(!still && !a) note.push(e.l+' no audio');
      n++; }
    return JSON.stringify({done:n,remaining:rem,note:note.slice(0,10)});`,
  check: `
    var s=p.activeSequence, o=[], t, q, c;
    for(t=0;t<1;t++){ for(q=0;q<s.videoTracks[0].clips.numItems;q++){ c=s.videoTracks[0].clips[q]; o.push('v '+R(c.start.seconds)+'-'+R(c.end.seconds)+' in '+R(c.inPoint.seconds)+' '+String(c.name)); } }
    for(q=0;q<s.audioTracks[0].clips.numItems;q++){ c=s.audioTracks[0].clips[q]; o.push('a '+R(c.start.seconds)+'-'+R(c.end.seconds)+' in '+R(c.inPoint.seconds)+' '+String(c.name)); }
    return JSON.stringify({seq:String(s.name), end:s.end/254016000000, n:o.length, items:o.slice(0,40)});`,
};

if (STEP === 'prepare' || STEP === 'check') console.log(JSON.stringify(await run(BODY[STEP]), null, 1));
else if (STEP === 'empty' || STEP === 'place') await loop(BODY[STEP], STEP);
else { console.error('unknown step'); process.exit(2); }
