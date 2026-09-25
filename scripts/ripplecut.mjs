// Ripple-delete [a, b] on EVERY track of the active sequence and keep all tracks in sync.
//
// The host's own ripple delete (applyTimecodeEdits) shifts only the tracks that have
// something under the range, so a slide or a screen recording above it drifts. Here clips
// across a or b are razored there (a still is trimmed instead, so a slide over the cut stays
// one clip), pieces inside are removed, and every item after b moves left by b - a in
// ascending order. No item passes another, so each track's item list stays in time order
// (moving clips past each other breaks a track: see trackorder.mjs). Markers after b and
// the in/out points move too.
//
//   node scripts/ripplecut.mjs --seq "<active sequence>" --cut <a>,<b> [--batch 12] [--fps 25]
//
// a and b sit on the frame grid, in the sequence's current coordinates. The layout after
// the razor is saved to <repo>/gen-out/ripple_<sequenceID>_<a>_<b>.json on the first run and
// every later step works from those absolute positions, so a re-run after a bridge timeout or
// an error — from any working directory — never razors or shifts anything twice. To cut the
// same range again after an Undo in Premiere, delete that file first.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { callBridge } from './lib/prbridge.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : d; };
const SEQ = arg('seq'), CUT = String(arg('cut', '')).split(',').map(Number), BATCH = +arg('batch', 12), FPS = +arg('fps', 25);
if (!SEQ || CUT.length !== 2 || !(CUT[1] > CUT[0])) { console.error('usage: ripplecut.mjs --seq <name> --cut <a>,<b>'); process.exit(2); }
const [A, Z] = CUT, D = +(Z - A).toFixed(6), EPS = 0.005;
const GENOUT = fileURLToPath(new URL('../gen-out/', import.meta.url));
mkdirSync(GENOUT, { recursive: true });
let STATE;   // keyed by the sequence's ID, set once the active sequence is confirmed

const HEAD = `var SEQ=${JSON.stringify(SEQ)}, FPS=${FPS}, EPS=${EPS}, B=${BATCH};
var s=app.project.activeSequence;
function pad(n){return n<10?'0'+n:''+n;}
function tcOf(sec){ if($._EXT_PRM_ && $._EXT_PRM_._secToTimecode) return $._EXT_PRM_._secToTimecode(sec,FPS);
  var f=Math.round(sec*FPS); return pad(Math.floor(f/(FPS*3600)))+':'+pad(Math.floor(f/(FPS*60))%60)+':'+pad(Math.floor(f/FPS)%60)+';'+pad(f%FPS); }
function isAV(c){ try{ return /[.](mov|mp4|m4v|mxf|braw|r3d|avi|mts|m2ts|mkv|webm|wav|mp3|m4a|aiff?|flac)$/i.test(String(c.projectItem.getMediaPath())); }catch(e){ return false; } }
// a still reports the default source range 3599.96-3604.96; a real take can start at 1:00:00 too
function isStill(c){ return /[.](png|jpe?g|tiff?|psd|bmp|gif)$/i.test(String(c.name)) || (Math.abs(c.inPoint.seconds-3600)<0.1 && !isAV(c)); }
function clips(){ var o=[],i,j,t,c;
  for(i=0;i<s.videoTracks.numTracks;i++){t=s.videoTracks[i];for(j=0;j<t.clips.numItems;j++){c=t.clips[j];
    o.push({k:'v',tr:i,c:c,st:c.start.seconds,en:c.end.seconds,id:String(c.nodeId)});}}
  for(i=0;i<s.audioTracks.numTracks;i++){t=s.audioTracks[i];for(j=0;j<t.clips.numItems;j++){c=t.clips[j];
    o.push({k:'a',tr:i,c:c,st:c.start.seconds,en:c.end.seconds,id:String(c.nodeId)});}}
  return o; }
function index(){ var o=clips(),m={},i; for(i=0;i<o.length;i++) m[o[i].id]=o[i]; return m; }
function tm(x){var t=new Time();t.seconds=x;return t;}
function R(x){return Math.round(x*1000)/1000;}
`;
const wrap = (body) => `(function(){try{${HEAD}
if(!s || String(s.name)!==SEQ) return JSON.stringify({error:'active sequence is '+(s?s.name:'none')+', not '+SEQ});
${body}
}catch(e){return JSON.stringify({error:String(e),line:e.line});}})()`;

const isTimeout = (e) => /timeout|timed out|не ответил/i.test(String(e));
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function run(body) {
  const raw = await callBridge('evalJson', [wrap(body)], { timeoutMs: 30000 });
  const r = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (r && r.error) throw new Error(JSON.stringify(r));
  return r;
}
async function loop(body, label) {
  for (let pass = 1; pass <= 200; pass++) {
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

STATE = join(GENOUT, `ripple_${(await run('return JSON.stringify({id:String(s.sequenceID)});')).id}_${A}_${Z}.json`);
// Runs before 2026-09-25 keyed the state by the sequence NAME: continue such a run instead of
// razoring again, but only when its surviving items are found in this very sequence.
if (!existsSync(STATE)) {
  const legacy = join(GENOUT, `ripple_${SEQ.replace(/[^\p{L}\p{N}]+/gu, '_')}_${A}_${Z}.json`);
  if (existsSync(legacy)) {
    const old = JSON.parse(readFileSync(legacy, 'utf8'));
    const ids = [...(old.keep || []), ...(old.shifts || [])].map((x) => x.id).slice(0, 200);
    const hit = (await run(`var m=index(), I=${JSON.stringify(ids)}, n=0, i; for(i=0;i<I.length;i++) if(m[I[i]]) n++; return JSON.stringify({n:n});`)).n;
    if (ids.length && hit >= 0.8 * ids.length) { writeFileSync(STATE, JSON.stringify(old, null, 1)); console.error(`state: continuing the run recorded in ${legacy}`); }
    else console.error(`state: ${legacy} is another sequence's (${hit}/${ids.length} items here), ignored`);
  }
}

// 1. razor every non-still clip that crosses a or b — on the first run only: once the items
//    after b have moved, the one now starting at a crosses b, and a second razor would split it
if (existsSync(STATE)) console.error(`razor: done on the first run (${STATE})`);
else {
  const rz = await run(`app.enableQE(); var q=qe.project.getActiveSequence(), o=clips(), i, k, T=[${A},${Z}], done=[];
    for(k=0;k<2;k++){ var x=T[k], vt={}, at={}, t;
      for(i=0;i<o.length;i++) if(o[i].st<x-EPS && o[i].en>x+EPS && !isStill(o[i].c)){ if(o[i].k==='v') vt[o[i].tr]=1; else at[o[i].tr]=1; }
      for(t in vt){ q.getVideoTrackAt(+t).razor(tcOf(x),true,true); done.push('V'+(+t+1)+'@'+x); }
      for(t in at){ q.getAudioTrackAt(+t).razor(tcOf(x),true,true); done.push('A'+(+t+1)+'@'+x); } }
    o=clips(); var bad=[];
    for(k=0;k<2;k++) for(i=0;i<o.length;i++) if(o[i].st<T[k]-EPS && o[i].en>T[k]+EPS && !isStill(o[i].c)) bad.push(o[i].k+(o[i].tr+1)+'@'+T[k]);
    return JSON.stringify({razored:done, stillSpanning:bad});`);
  console.error(`razor: ${rz.razored.join(' ') || 'nothing to cut'}`);
  if (rz.stillSpanning.length) throw new Error(`clips still cross the cut: ${rz.stillSpanning}`);
}

// 2. the layout after the razor, once
let st;
if (existsSync(STATE)) {
  st = JSON.parse(readFileSync(STATE, 'utf8'));
} else {
  const snap = await run(`var o=clips(), r=[], i, c;
    for(i=0;i<o.length;i++){ c=o[i].c; r.push({k:o[i].k,tr:o[i].tr,st:R(o[i].st),en:R(o[i].en),sIn:R(c.inPoint.seconds),name:String(c.name),still:isStill(c)?1:0,id:o[i].id}); }
    var m=s.markers, k=m.getFirstMarker(), ms=[], n=0;
    while(k && n<5000){ ms.push({st:R(k.start.seconds),en:R(k.end.seconds),name:String(k.name),guid:String(k.guid)}); n++; k=m.getNextMarker(k); }
    return JSON.stringify({items:r, markers:ms, inP:parseFloat(s.getInPoint()), outP:parseFloat(s.getOutPoint())});`);
  const it = snap.items;
  const remove = it.filter((c) => c.st >= A - EPS && c.en <= Z + EPS);
  const trims = it.filter((c) => c.still && c.st < A - EPS && c.en > A + EPS).map((c) => ({ id: c.id, en: +(c.en > Z + EPS ? c.en - D : A).toFixed(3) }));
  const heads = it.filter((c) => c.still && c.st >= A - EPS && c.st < Z - EPS && c.en > Z + EPS).map((c) => ({ id: c.id, st: c.st, tg: A, en: +(c.en - D).toFixed(3) }));
  const shifts = it.filter((c) => c.st >= Z - EPS).map((c) => ({ id: c.id, k: c.k, st: c.st, tg: +(c.st - D).toFixed(3) }))
    .sort((p, q) => (p.k === q.k ? p.st - q.st : p.k === 'v' ? -1 : 1));
  const touched = new Set([...remove, ...shifts].map((c) => c.id).concat(trims.map((t) => t.id), heads.map((h) => h.id)));
  const keep = it.filter((c) => !touched.has(c.id)).map((c) => ({ id: c.id, st: c.st, en: c.en }));
  const marks = snap.markers.filter((m) => m.st >= A - EPS).map((m) => ({ ...m, tg: +(m.st >= Z - EPS ? m.st - D : A).toFixed(3) }));
  const mvp = (x) => +(x > Z + EPS ? x - D : x > A ? A : x).toFixed(3);
  st = { seq: SEQ, a: A, b: Z, d: D, remove: remove.map((c) => c.id), trims, heads, shifts, keep, marks,
    inP: snap.inP, outP: snap.outP, inTg: mvp(snap.inP), outTg: mvp(snap.outP) };
  writeFileSync(STATE, JSON.stringify(st, null, 1));
  console.error(`plan: remove ${remove.length}, trim ${trims.length + heads.length} still(s), shift ${shifts.length} items and ${marks.length} markers by -${D}; out ${snap.outP} -> ${st.outTg}`);
}

// 3. remove the pieces inside the range
await loop(`var ids=${JSON.stringify(st.remove)}, m=index(), n=0, rem=0, i;
  for(i=0;i<ids.length;i++){ var x=m[ids[i]]; if(!x) continue; if(n>=B){rem++;continue;} x.c.remove(0,1); n++; m=index(); }
  return JSON.stringify({done:n, remaining:rem});`, 'remove');

// 4. stills across the range: shorten in place (a slide over the cut stays one clip)
const tr = await run(`var T=${JSON.stringify(st.trims)}, H=${JSON.stringify(st.heads)}, m=index(), i, bad=[], n=0;
  for(i=0;i<T.length;i++){ var x=m[T[i].id]; if(!x){bad.push('gone '+T[i].id);continue;}
    if(Math.abs(x.c.end.seconds-T[i].en)>EPS){ x.c.end=tm(T[i].en); n++; }
    if(Math.abs(x.c.end.seconds-T[i].en)>EPS) bad.push('trim failed '+String(x.c.name)); }
  for(i=0;i<H.length;i++){ var y=m[H[i].id]; if(!y){bad.push('gone '+H[i].id);continue;}
    if(Math.abs(y.c.start.seconds-H[i].st)<EPS) y.c.move(tm(H[i].tg-H[i].st));
    if(Math.abs(y.c.end.seconds-H[i].en)>EPS) y.c.end=tm(H[i].en); n++;
    if(Math.abs(y.c.start.seconds-H[i].tg)>EPS||Math.abs(y.c.end.seconds-H[i].en)>EPS) bad.push('head trim failed '+String(y.c.name)); }
  return JSON.stringify({done:n, bad:bad});`);
if (tr.bad.length) throw new Error(`trim: ${tr.bad}`);
console.error(`  stills trimmed: ${tr.done}`);

// 5. everything after b moves left, ascending; a linked partner the host dragged along is skipped
await loop(`var S=${JSON.stringify(st.shifts)}, m=index(), n=0, rem=0, i, bad=[];
  for(i=0;i<S.length;i++){ var x=m[S[i].id]; if(!x){bad.push('gone '+S[i].id);continue;}
    var cur=x.c.start.seconds;
    if(Math.abs(cur-S[i].tg)<EPS) continue;
    if(Math.abs(cur-S[i].st)>EPS){ bad.push('unexpected '+String(x.c.name)+' at '+R(cur)); continue; }
    if(n>=B){ rem++; continue; }
    x.c.move(tm(S[i].tg-cur)); n++; }
  return JSON.stringify({done:n, remaining:rem, bad:bad.slice(0,10)});`, 'shift');

// 6. markers and in/out. Marker times take plain seconds: a Time object is an
//    "Illegal Parameter type". A marker that refuses to move is re-created (name, comment,
//    colour, length) and the old one deleted.
const mk = await run(`var M=${JSON.stringify(st.marks)}, mm=s.markers, all=[], k=mm.getFirstMarker(), n=0, i, j, bad=[], done=0, made=0;
  while(k && n<5000){ all.push(k); n++; k=mm.getNextMarker(k); }
  for(i=0;i<M.length;i++){ var hit=null, there=false;
    for(j=0;j<all.length;j++){ if(String(all[j].guid)===M[i].guid) hit=all[j];
      if(String(all[j].name)===M[i].name && Math.abs(all[j].start.seconds-M[i].tg)<EPS) there=true; }
    if(there) continue;
    if(!hit){ bad.push('no marker '+M[i].name); continue; }
    var len=hit.end.seconds-hit.start.seconds, moved=false;
    // assigning start MOVES the marker and keeps its length, so start first, then end —
    // end first would stretch it, and the move would carry the stretch along
    try{ hit.start=M[i].tg; hit.end=M[i].tg+len;
      moved=Math.abs(hit.start.seconds-M[i].tg)<EPS; }catch(e0){}
    if(!moved){
      var nw=mm.createMarker(M[i].tg); nw.name=hit.name; nw.comments=hit.comments; if(len>0) nw.end=M[i].tg+len;
      try{ nw.setColorByIndex(hit.getColorByIndex()); }catch(e1){}
      mm.deleteMarker(hit); made++; }
    done++; }
  // an unset In/Out reads -400000: leave it unset (and never paste a negative number after a
  // minus sign — "x--400000" is a decrement and the whole script fails to parse)
  var OT=(${st.outTg}), IT=(${st.inTg});
  if((${st.outP})>=0 && Math.abs(parseFloat(s.getOutPoint())-OT)>EPS) s.setOutPoint(OT);
  if((${st.inP})>=0 && Math.abs(parseFloat(s.getInPoint())-IT)>EPS) s.setInPoint(IT);
  return JSON.stringify({done:done, recreated:made, bad:bad, out:parseFloat(s.getOutPoint())});`);
if (mk.bad.length) throw new Error(`markers: ${mk.bad}`);
console.error(`  markers moved: ${mk.done}${mk.recreated ? ` (${mk.recreated} re-created)` : ''}; out ${mk.out}`);

// 7. check: every item where the plan says, nothing overlapping, lists in time order
const ck = await run(`var m=index(), i, bad=[], inv=0, t, q, tr, last=0;
  var RM=${JSON.stringify(st.remove)}, S=${JSON.stringify(st.shifts)}, T=${JSON.stringify(st.trims)}, K=${JSON.stringify(st.keep)};
  for(i=0;i<RM.length;i++) if(m[RM[i]]) bad.push('not removed '+String(m[RM[i]].c.name)+' @'+R(m[RM[i]].st));
  for(i=0;i<S.length;i++){ var x=m[S[i].id]; if(!x) bad.push('shifted item gone'); else if(Math.abs(x.st-S[i].tg)>EPS) bad.push('not shifted '+String(x.c.name)+' @'+R(x.st)); }
  for(i=0;i<T.length;i++){ var y=m[T[i].id]; if(!y||Math.abs(y.en-T[i].en)>EPS) bad.push('trim lost'); }
  for(i=0;i<K.length;i++){ var z=m[K[i].id]; if(!z||Math.abs(z.st-K[i].st)>EPS||Math.abs(z.en-K[i].en)>EPS) bad.push('untouched item changed @'+K[i].st); }
  function scan(T2,label){ for(t=0;t<T2.numTracks;t++){ tr=T2[t]; for(q=0;q<tr.clips.numItems;q++){ var c=tr.clips[q];
      if(c.end.seconds>last) last=c.end.seconds;
      if(q>0 && c.start.seconds<tr.clips[q-1].start.seconds-0.001) inv++;
      if(q>0 && c.start.seconds<tr.clips[q-1].end.seconds-EPS) bad.push('overlap '+label+(t+1)+' @'+R(c.start.seconds)); } } }
  scan(s.videoTracks,'V'); scan(s.audioTracks,'A');
  return JSON.stringify({bad:bad.slice(0,20), inversions:inv, seqEnd:R(s.end/254016000000), lastClip:R(last), out:parseFloat(s.getOutPoint())});`);
console.log(JSON.stringify(ck));
process.exit(ck.bad.length || ck.inversions || Math.abs(ck.seqEnd - ck.lastClip) > 0.05 ? 1 : 0);
