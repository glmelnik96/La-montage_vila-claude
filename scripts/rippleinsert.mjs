// Open gaps on EVERY track of the active sequence and keep all tracks in sync: the mirror of
// ripplecut.mjs, for cards or pauses inserted into a finished edit.
//
// The host's insert edits ripple only the target track (track.insertClip and
// sequence.insertClip moved V1 and the markers, while A1, V2 and V3 stayed). Here every item
// starting at or after a gap moves right; a still, adjustment layer or graphic crossing it grows,
// so one clip spans the gap; a clip on an --extend track (music) crossing it, or starting exactly
// on it, grows too — outPoint first — so the music plays on through the card. Any other clip
// crossing a gap stops the run before anything changes: put the gap on an edit point.
// Transitions move with their clips: TrackItem.move() leaves a clip's fades behind, and on
// 2026-10-08 a dialogue clip whose Custom Fade stayed behind played its source 14.88 s early
// (its Enhance Speech pre-render followed the stale fade) while every DOM read looked right.
// Markers and the In/Out move too. Moves go in descending start order, so no item passes another
// and each track's item list stays in time order (see trackorder.mjs).
//
//   node scripts/rippleinsert.mjs --seq "<active sequence>" --at <t>:<d>[,<t>:<d>...] \
//        [--extend A4,A7] [--batch 20] [--fps 25] [--dry-run]
//
// t and d sit on the frame grid, t in the sequence's CURRENT coordinates (all gaps at once, not
// one after another). The plan is saved to <repo>/gen-out/rippleins_<sequenceID>_<gaps>.json on
// the first run; a re-run after a bridge timeout continues from it and never moves anything twice.
// A music clip that cannot grow (its source, or its Remix, ends) is reported as `short`, with the
// end it reached.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { callBridge } from './lib/prbridge.mjs';
import { planInserts } from './lib/insertplan.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : d; };
const SEQ = arg('seq'), BATCH = +arg('batch', 20), FPS = +arg('fps', 25), EPS = 0.005;
const INS = String(arg('at', '')).split(',').filter(Boolean).map((s) => { const [at, d] = s.split(':').map(Number); return { at, d }; });
const EXTEND = String(arg('extend', '')).split(',').filter(Boolean), DRY = process.argv.includes('--dry-run');
if (!SEQ || !INS.length || INS.some((i) => !(i.at >= 0) || !(i.d > 0))) {
  console.error('usage: rippleinsert.mjs --seq <name> --at <t>:<d>[,<t>:<d>...] [--extend A4,A7]'); process.exit(2);
}
for (const i of INS) for (const x of [i.at, i.d]) if (Math.abs(x * FPS - Math.round(x * FPS)) > 1e-6) { console.error(`${x} is off the ${FPS} fps frame grid`); process.exit(2); }
const GENOUT = fileURLToPath(new URL('../gen-out/', import.meta.url));
mkdirSync(GENOUT, { recursive: true });

const HEAD = `var SEQ=${JSON.stringify(SEQ)}, EPS=${EPS};
var s=app.project.activeSequence;
function isAV(c){ try{ return /[.](mov|mp4|m4v|mxf|braw|r3d|avi|mts|m2ts|mkv|webm|wav|mp3|m4a|aiff?|flac)$/i.test(String(c.projectItem.getMediaPath())); }catch(e){ return false; } }
// a still reports the default source range 3599.96-3604.96; so do adjustment layers and graphics
function isStill(c){ return /[.](png|jpe?g|tiff?|psd|bmp|gif)$/i.test(String(c.name)) || (Math.abs(c.inPoint.seconds-3600)<0.1 && !isAV(c)); }
function clips(){ var o=[],i,j,t,c;
  for(i=0;i<s.videoTracks.numTracks;i++){t=s.videoTracks[i];for(j=0;j<t.clips.numItems;j++){c=t.clips[j];
    o.push({k:'v',tr:i,c:c,st:c.start.seconds,en:c.end.seconds,id:String(c.nodeId)});}}
  for(i=0;i<s.audioTracks.numTracks;i++){t=s.audioTracks[i];for(j=0;j<t.clips.numItems;j++){c=t.clips[j];
    o.push({k:'a',tr:i,c:c,st:c.start.seconds,en:c.end.seconds,id:String(c.nodeId)});}}
  return o; }
function index(){ var o=clips(),m={},i; for(i=0;i<o.length;i++) m[o[i].id]=o[i]; return m; }
// every Time in whole frames of ticks, moves to absolute targets (see ripplecut.mjs)
var TPF=Number(s.getSettings().videoFrameRate.ticks);
function tk(x){ return Math.round(x*254016000000/TPF)*TPF; }
function tm(x){var t=new Time();t.ticks=String(tk(x));return t;}
function moveTo(c,x){var d=new Time();d.ticks=String(tk(x)-Number(c.start.ticks));c.move(d);}
function R(x){return Math.round(x*1000)/1000;}
`;
const wrap = (body) => `(function(){try{${HEAD}
if(!s || String(s.name)!==SEQ) return JSON.stringify({error:'active sequence is '+(s?s.name:'none')+', not '+SEQ});
${body}
}catch(e){return JSON.stringify({error:String(e),line:e.line});}})()`;
const isTimeout = (e) => /timeout|timed out|не ответил/i.test(String(e));
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function run(body, timeoutMs = 60000) {
  const raw = await callBridge('evalJson', [wrap(body)], { timeoutMs });
  const r = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (r && r.error) throw new Error(JSON.stringify(r));
  return r;
}
async function loop(body, label) {
  for (let pass = 1; pass <= 300; pass++) {
    let r;
    try { r = await run(body); } catch (e) {
      if (isTimeout(e)) { console.error(`  ${label}: bridge timeout, re-checking`); await pause(8000); continue; }
      throw e;
    }
    if (r.bad && r.bad.length) throw new Error(`${label}: ${JSON.stringify(r.bad)}`);
    console.error(`  ${label} pass ${pass}: done ${r.done}, remaining ${r.remaining}`);
    if (r.remaining === 0) return r;
    if (r.done === 0) throw new Error(`${label} stalled`);
  }
  throw new Error(`${label}: did not converge`);
}

const seqId = (await run('return JSON.stringify({id:String(s.sequenceID)});')).id;
const STATE = join(GENOUT, `rippleins_${seqId}_${INS.map((i) => `${i.at}+${i.d}`).join('_')}.json`);
let st;
if (existsSync(STATE)) {
  st = JSON.parse(readFileSync(STATE, 'utf8'));
  console.error(`plan: continuing ${STATE}`);
} else {
  const snap = await run(`var o=clips(), r=[], i;
    for(i=0;i<o.length;i++) r.push({k:o[i].k,tr:o[i].tr,st:R(o[i].st),en:R(o[i].en),name:String(o[i].c.name),still:isStill(o[i].c)?1:0,id:o[i].id});
    var m=s.markers, k=m.getFirstMarker(), ms=[], n=0;
    while(k && n<5000){ ms.push({st:R(k.start.seconds),en:R(k.end.seconds),name:String(k.name),guid:String(k.guid)}); n++; k=m.getNextMarker(k); }
    var trs=[], G2=[s.videoTracks, s.audioTracks], z, u, TT;
    for(z=0;z<2;z++) for(u=0;u<G2[z].numTracks;u++){ TT=G2[z][u].transitions; for(var w=0;w<TT.numItems;w++) trs.push({k:z?'a':'v', tr:u, st:R(TT[w].start.seconds), en:R(TT[w].end.seconds), name:String(TT[w].name)}); }
    // items that already overlap their predecessor (a transition between them) are not new overlaps
    var pre=[], T2, t, q; for(t=0;t<2;t++){ T2=t?s.audioTracks:s.videoTracks; for(i=0;i<T2.numTracks;i++){ var L=T2[i].clips;
      for(q=1;q<L.numItems;q++) if(L[q].start.seconds<L[q-1].end.seconds-EPS) pre.push(String(L[q].nodeId)); } }
    return JSON.stringify({items:r, markers:ms, pre:pre, transitions:trs, inP:parseFloat(s.getInPoint()), outP:parseFloat(s.getOutPoint())});`, 110000);
  const p = planInserts(snap.items, snap.markers, INS, { extend: EXTEND, inP: snap.inP, outP: snap.outP, transitions: snap.transitions });
  if (p.crossing.length) {
    console.error('clips cross a gap; nothing was changed:');
    for (const c of p.crossing) console.error(`  ${c.label} ${c.transition ? 'transition ' : ''}${c.name} ${c.st}-${c.en} across ${c.at.join(', ')}`);
    process.exit(1);
  }
  if (DRY) {
    console.log(JSON.stringify({ total: p.total, moves: p.moves.length, transitions: p.tmoves.length, marks: p.marks.length, inTg: p.inTg, outTg: p.outTg,
      grows: p.grows.map((g) => `${g.label} ${g.name} ${g.st}-${g.en} -> ${g.tgEn}`) }, null, 1));
    process.exit(0);
  }
  st = { seq: SEQ, inserts: p.inserts, total: p.total, moves: p.moves, grows: p.grows, marks: p.marks, pre: snap.pre, tmoves: p.tmoves,
    inP: snap.inP, outP: snap.outP, inTg: p.inTg, outTg: p.outTg,
    keep: snap.items.filter((c) => !p.moves.some((m) => m.id === c.id) && !p.grows.some((g) => g.id === c.id)).map((c) => ({ id: c.id, st: c.st, en: c.en })) };
  writeFileSync(STATE, JSON.stringify(st, null, 1));
  console.error(`plan: ${p.inserts.length} gaps, ${p.total} s in all; move ${p.moves.length} items and ${p.tmoves.length} transitions, grow ${p.grows.length}` +
    ` (${p.grows.map((g) => `${g.label} ${g.name}`).join(', ')}), ${p.marks.length} markers; out ${snap.outP} -> ${p.outTg}`);
}

// 1. moves, latest first; a linked partner the host dragged along is found at its target and skipped
await loop(`var S=${JSON.stringify(st.moves.map((m) => ({ id: m.id, st: m.st, tg: m.tg })))}, m=index(), n=0, rem=0, i, bad=[];
  for(i=0;i<S.length;i++){ var x=m[S[i].id]; if(!x){bad.push('gone '+S[i].id);continue;}
    var cur=x.c.start.seconds;
    if(Math.abs(cur-S[i].tg)<EPS) continue;
    if(Math.abs(cur-S[i].st)>EPS){ bad.push('unexpected '+String(x.c.name)+' at '+R(cur)); continue; }
    if(n>=${BATCH}){ rem++; continue; }
    moveTo(x.c, S[i].tg); n++; }
  return JSON.stringify({done:n, remaining:rem, bad:bad.slice(0,10)});`, 'move');

// 2. growth: media clips get their outPoint first (assigning end alone lengthens the item and
//    leaves the outPoint), stills and adjustment layers only the end
const gr = await run(`var G=${JSON.stringify(st.grows)}, m=index(), i, bad=[], lacking=[], n=0;
  for(i=0;i<G.length;i++){ var x=m[G[i].id]; if(!x){bad.push('gone '+G[i].id);continue;}
    var c=x.c;
    if(Math.abs(c.end.seconds-G[i].tgEn)<EPS) continue;
    if(Math.abs(c.start.seconds-G[i].st)>EPS || Math.abs(c.end.seconds-G[i].en)>EPS){ bad.push('unexpected '+String(c.name)+' '+R(c.start.seconds)+'-'+R(c.end.seconds)); continue; }
    var add=tk(G[i].tgEn)-tk(G[i].en);
    if(G[i].media){ var o=new Time(); o.ticks=String(Number(c.outPoint.ticks)+add); c.outPoint=o; }
    if(Math.abs(c.end.seconds-G[i].tgEn)>EPS) c.end=tm(G[i].tgEn);
    n++;
    if(Math.abs(c.end.seconds-G[i].tgEn)>EPS) lacking.push({name:String(c.name), label:G[i].label, wanted:G[i].tgEn, got:R(c.end.seconds)}); }
  return JSON.stringify({done:n, bad:bad, lacking:lacking});`);
if (gr.bad.length) throw new Error(`grow: ${JSON.stringify(gr.bad)}`);
console.error(`  grown: ${gr.done}${gr.lacking.length ? `; SHORT: ${JSON.stringify(gr.lacking)}` : ''}`);

// 3. transitions, latest first, each found by its track and start (Track.transitions; move() takes
//    a Time delta like a clip's). A plan from before 2026-10-08 has none: re-check by hand.
const tm = await run(`var L=${JSON.stringify(st.tmoves || [])}, i, j, bad=[], n=0;
  for(i=0;i<L.length;i++){ var TT=(L[i].k==='v'?s.videoTracks:s.audioTracks)[L[i].tr].transitions, hit=null, there=false;
    for(j=0;j<TT.numItems;j++){ var x=TT[j]; if(Math.abs(x.start.seconds-L[i].tg)<EPS) there=true; else if(Math.abs(x.start.seconds-L[i].st)<EPS) hit=x; }
    if(there) continue;
    if(!hit){ bad.push('no transition '+L[i].label+' @'+L[i].st); continue; }
    var d=new Time(); d.ticks=String(tk(L[i].tg)-Number(hit.start.ticks)); hit.move(d); n++;
    if(Math.abs(hit.start.seconds-L[i].tg)>EPS) bad.push('transition did not move '+L[i].label+' @'+L[i].st); }
  return JSON.stringify({done:n, bad:bad});`, 110000);
if (tm.bad.length) throw new Error(`transitions: ${JSON.stringify(tm.bad)}`);
console.error(`  transitions moved: ${tm.done}`);

// 4. markers (start first, then end: assigning start moves the marker) and the In/Out
const mk = await run(`var M=${JSON.stringify(st.marks)}, mm=s.markers, all=[], k=mm.getFirstMarker(), n=0, i, j, bad=[], done=0, made=0;
  while(k && n<5000){ all.push(k); n++; k=mm.getNextMarker(k); }
  for(i=0;i<M.length;i++){ var hit=null, there=false;
    for(j=0;j<all.length;j++){ if(String(all[j].guid)===M[i].guid) hit=all[j];
      if(String(all[j].name)===M[i].name && Math.abs(all[j].start.seconds-M[i].tg)<EPS) there=true; }
    if(there) continue;
    if(!hit){ bad.push('no marker '+M[i].name); continue; }
    var len=hit.end.seconds-hit.start.seconds, moved=false;
    try{ hit.start=M[i].tg; hit.end=M[i].tg+len; moved=Math.abs(hit.start.seconds-M[i].tg)<EPS; }catch(e0){}
    if(!moved){
      var nw=mm.createMarker(M[i].tg); nw.name=hit.name; nw.comments=hit.comments; if(len>0) nw.end=M[i].tg+len;
      try{ nw.setColorByIndex(hit.getColorByIndex()); }catch(e1){}
      mm.deleteMarker(hit); made++; }
    done++; }
  var OT=(${st.outTg}), IT=(${st.inTg});
  if((${st.outP})>=0 && Math.abs(parseFloat(s.getOutPoint())-OT)>EPS) s.setOutPoint(OT);
  if((${st.inP})>=0 && Math.abs(parseFloat(s.getInPoint())-IT)>EPS) s.setInPoint(IT);
  return JSON.stringify({done:done, recreated:made, bad:bad, out:parseFloat(s.getOutPoint())});`, 110000);
if (mk.bad.length) throw new Error(`markers: ${mk.bad}`);
console.error(`  markers moved: ${mk.done}${mk.recreated ? ` (${mk.recreated} re-created)` : ''}; out ${mk.out}`);

// 5. check: moved items at their targets, untouched ones unchanged, nothing overlapping, lists in order
const ck = await run(`var m=index(), i, bad=[], inv=0, t, q, tr, last=0;
  var S=${JSON.stringify(st.moves.map((x) => ({ id: x.id, tg: x.tg })))}, K=${JSON.stringify(st.keep)}, PRE={}, P0=${JSON.stringify(st.pre || [])}, TM=${JSON.stringify(st.tmoves || [])};
  for(i=0;i<TM.length;i++){ var TT=(TM[i].k==='v'?s.videoTracks:s.audioTracks)[TM[i].tr].transitions, ok=false;
    for(var j2=0;j2<TT.numItems;j2++) if(Math.abs(TT[j2].start.seconds-TM[i].tg)<EPS) ok=true;
    if(!ok) bad.push('transition not at '+TM[i].label+' @'+TM[i].tg); }
  for(i=0;i<P0.length;i++) PRE[P0[i]]=1;
  for(i=0;i<S.length;i++){ var x=m[S[i].id]; if(!x) bad.push('moved item gone'); else if(Math.abs(x.st-S[i].tg)>EPS) bad.push('not moved '+String(x.c.name)+' @'+R(x.st)); }
  for(i=0;i<K.length;i++){ var z=m[K[i].id]; if(!z||Math.abs(z.st-K[i].st)>EPS||Math.abs(z.en-K[i].en)>EPS) bad.push('untouched item changed @'+K[i].st); }
  function scan(T2,label){ for(t=0;t<T2.numTracks;t++){ tr=T2[t]; for(q=0;q<tr.clips.numItems;q++){ var c=tr.clips[q];
      if(c.end.seconds>last) last=c.end.seconds;
      if(q>0 && c.start.seconds<tr.clips[q-1].start.seconds-0.001) inv++;
      if(q>0 && c.start.seconds<tr.clips[q-1].end.seconds-EPS && !PRE[String(c.nodeId)]) bad.push('overlap '+label+(t+1)+' @'+R(c.start.seconds)); } } }
  scan(s.videoTracks,'V'); scan(s.audioTracks,'A');
  return JSON.stringify({bad:bad.slice(0,20), inversions:inv, seqEnd:R(s.end/254016000000), lastClip:R(last), out:parseFloat(s.getOutPoint())});`, 110000);
console.log(JSON.stringify({ ...ck, short: gr.lacking }));
process.exit(ck.bad.length || ck.inversions ? 1 : 0);
