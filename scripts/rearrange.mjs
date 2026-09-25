// Rearrange the active sequence in place: razor, lift, and move every clip to an
// absolute new position.
//
// WARNING (Premiere 26.3): moving clips PAST EACH OTHER with move() leaves the track's
// internal item list in the old order — the DOM reports every clip correctly while the
// timeline panel draws it empty and the renderer drops its video. When the new order
// differs from the old, build with assemble.mjs (insert in time order) instead.
//
// Why not ripple deletes and insert edits: the host's ripple delete removes the
// pieces under the range track by track, so a track with NOTHING under the range
// is not shifted. Cut 10 s out of V1 while V2 is empty there, and every later
// clip on V2 (a screen recording, a slide) stays where it was — 10 s out of sync
// with the camera. Absolute targets cannot drift that way.
//
//   node scripts/rearrange.mjs --plan <plan.json> --step <step> [--batch 12] [--out dump.json]
//
//   steps: test-move | razor | lift | park | place | dump | all
//
// plan.json — every time in the sequence's CURRENT coordinates:
// {
//   "seq":   "<name of the active sequence; anything else is refused>",
//   "fps":   25,
//   "razor": [t, ...],                           cut every track at these times
//   "lift":  [[a, b], ...],                      remove every piece lying inside [a, b]
//   "map":   [{"a": a, "b": b, "ns": x}, ...],   a piece starting in [a, b) goes to x + (start - a)
//   "park":  5000                                a time past the end, used as a staging area
// }
//
// Moves take two passes: everything is parked past the end, then placed at its
// target. One pass collides — a piece moving left lands on one that has not
// moved yet. Each step only touches pieces it has not handled, so re-running a
// step after a bridge timeout is safe (re-running a relative move is not, which
// is why nothing here is "move by X" without checking where the clip is first).
//
// TrackItem.move() takes a signed delta and moves ONLY the item it is called on: on
// Premiere 26.3 the linked A/V partner stays behind (the panel's own comment claims
// otherwise), so every video and audio piece is moved explicitly. `test-move` shows
// what this build does on the live sequence before anything real happens.
import { readFileSync, writeFileSync } from 'node:fs';
import { callBridge } from './lib/prbridge.mjs';

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : d;
};
const plan = JSON.parse(readFileSync(arg('plan'), 'utf8'));
const step = arg('step', 'dump');
const BATCH = +arg('batch', 12);

// Shared ExtendScript prelude. ES3 only: no let/const, arrows, or Array extras.
const HEAD = (extra) => `
var P=${JSON.stringify(plan)}; var EPS=0.005; ${extra || ''}
var s=app.project.activeSequence;
function pad(n){return n<10?'0'+n:''+n;}
function tcOf(sec){
  if($._EXT_PRM_ && $._EXT_PRM_._secToTimecode) return $._EXT_PRM_._secToTimecode(sec,P.fps);
  var f=Math.round(sec*P.fps);
  return pad(Math.floor(f/(P.fps*3600)))+':'+pad(Math.floor(f/(P.fps*60))%60)+':'+pad(Math.floor(f/P.fps)%60)+';'+pad(f%P.fps);
}
function clips(){
  var o=[],i,j,t,c;
  for(i=0;i<s.videoTracks.numTracks;i++){t=s.videoTracks[i];for(j=0;j<t.clips.numItems;j++){c=t.clips[j];
    o.push({k:'v',tr:i,c:c,st:c.start.seconds,en:c.end.seconds,id:String(c.nodeId)});}}
  for(i=0;i<s.audioTracks.numTracks;i++){t=s.audioTracks[i];for(j=0;j<t.clips.numItems;j++){c=t.clips[j];
    o.push({k:'a',tr:i,c:c,st:c.start.seconds,en:c.end.seconds,id:String(c.nodeId)});}}
  return o;
}
function byId(id){var o=clips(),i;for(i=0;i<o.length;i++) if(o[i].id===id) return o[i];return null;}
function mv(c,d){var t=new Time();t.seconds=d;c.move(t);}
function target(s0){var i,r;for(i=0;i<P.map.length;i++){r=P.map[i];if(s0>=r.a-EPS && s0<r.b-EPS) return r.ns+(s0-r.a);}return null;}
`;
const wrap = (body, extra) => `(function(){try{${HEAD(extra)}
if(!s || String(s.name)!==P.seq) return JSON.stringify({error:'active sequence is '+(s?s.name:'none')+', plan is for '+P.seq});
${body}
}catch(e){return JSON.stringify({error:String(e),line:e.line});}})()`;

const BODY = {
  'test-move': `
    var o=clips(),v=null,i,a0=[],a1=[],a2=[];
    for(i=0;i<o.length;i++) if(o[i].k==='v'&&o[i].tr===0&&(!v||o[i].st>v.st)) v=o[i];
    for(i=0;i<o.length;i++) if(o[i].k==='a'&&Math.abs(o[i].st-v.st)<EPS) a0.push(o[i].id);
    mv(v.c,7); var x=byId(v.id);
    for(i=0;i<a0.length;i++){var y=byId(a0[i]);a1.push(y?Math.round(y.st*1000)/1000:null);}
    mv(x.c,-7); var x2=byId(v.id);
    for(i=0;i<a0.length;i++){var z=byId(a0[i]);a2.push(z?Math.round(z.st*1000)/1000:null);}
    return JSON.stringify({v0:v.st,vMoved:x.st,vBack:x2.st,linkedAudio:a0.length,aMoved:a1,aBack:a2});`,
  razor: `
    app.enableQE(); var q=qe.project.getActiveSequence(),n=0,f=0,i,k;
    for(k=0;k<T.length;k++){var tc=tcOf(T[k]);
      for(i=0;i<q.numVideoTracks;i++){try{q.getVideoTrackAt(i).razor(tc,true,true);n++;}catch(e1){f++;}}
      for(i=0;i<q.numAudioTracks;i++){try{q.getAudioTrackAt(i).razor(tc,true,true);n++;}catch(e2){f++;}}}
    var o=clips(),bad=[];
    for(k=0;k<T.length;k++) for(i=0;i<o.length;i++) if(o[i].st<T[k]-EPS&&o[i].en>T[k]+EPS) bad.push(o[i].k+o[i].tr+'@'+T[k]);
    return JSON.stringify({razored:n,fails:f,stillSpanning:bad});`,
  // Batched like park/place: one call removing ~200 pieces outran the bridge's 30 s cap.
  lift: `
    var o=clips(),ids=[],i,r;
    for(i=0;i<o.length;i++) for(r=0;r<P.lift.length;r++)
      if(o[i].st>=P.lift[r][0]-EPS&&o[i].en<=P.lift[r][1]+EPS){ids.push(o[i].id);break;}
    var n=0;
    for(i=0;i<ids.length&&n<B;i++){var x=byId(ids[i]);if(!x)continue;x.c.remove(0,1);n++;}
    o=clips(); var left=[];
    for(i=0;i<o.length;i++) for(r=0;r<P.lift.length;r++)
      if(o[i].st<P.lift[r][1]-EPS&&o[i].en>P.lift[r][0]+EPS) left.push(o[i].k+o[i].tr+'@'+Math.round(o[i].st*100)/100);
    return JSON.stringify({moved:n,remaining:left.length,stillInside:left.slice(0,20)});`,
  park: `
    var o=clips(),v=[],a=[],i,n=0;
    for(i=0;i<o.length;i++) if(o[i].st<P.park-1){ if(o[i].k==='v') v.push(o[i]); else a.push(o[i]); }
    v.sort(function(p,q){return q.st-p.st;});
    for(i=0;i<v.length&&n<B;i++){mv(v[i].c,P.park);n++;}
    if(i>=v.length){
      o=clips(); a=[];
      for(i=0;i<o.length;i++) if(o[i].k==='a'&&o[i].st<P.park-1) a.push(o[i]);
      a.sort(function(p,q){return q.st-p.st;});
      for(i=0;i<a.length&&n<B;i++){mv(a[i].c,P.park);n++;}
    }
    o=clips(); var rem=0; for(i=0;i<o.length;i++) if(o[i].st<P.park-1) rem++;
    return JSON.stringify({moved:n,remaining:rem});`,
  place: `
    var o=clips(),v=[],a=[],i,n=0,un=[];
    for(i=0;i<o.length;i++) if(o[i].st>=P.park-1){
      var tg=target(o[i].st-P.park); if(tg===null){un.push(Math.round((o[i].st-P.park)*100)/100);continue;}
      if(o[i].k==='v') v.push({x:o[i],tg:tg}); else a.push({x:o[i],tg:tg}); }
    if(un.length) return JSON.stringify({error:'pieces outside every map range',at:un});
    v.sort(function(p,q){return p.tg-q.tg;});
    for(i=0;i<v.length&&n<B;i++){mv(v[i].x.c,v[i].tg-v[i].x.st);n++;}
    if(i>=v.length){
      o=clips(); a=[];
      for(i=0;i<o.length;i++) if(o[i].k==='a'&&o[i].st>=P.park-1) a.push({x:o[i],tg:target(o[i].st-P.park)});
      a.sort(function(p,q){return p.tg-q.tg;});
      for(i=0;i<a.length&&n<B;i++){mv(a[i].x.c,a[i].tg-a[i].x.st);n++;}
    }
    o=clips(); var rem=0; for(i=0;i<o.length;i++) if(o[i].st>=P.park-1) rem++;
    return JSON.stringify({moved:n,remaining:rem});`,
  dump: `
    var o=clips(),r=[],i;
    for(i=0;i<o.length;i++){var c=o[i].c;
      r.push({k:o[i].k,tr:o[i].tr,st:Math.round(o[i].st*1000)/1000,en:Math.round(o[i].en*1000)/1000,
        sIn:Math.round(c.inPoint.seconds*1000)/1000,sOut:Math.round(c.outPoint.seconds*1000)/1000,
        name:String(c.name),id:o[i].id});}
    return JSON.stringify({name:String(s.name),end:Math.round(s.end/254016000*1000)/1000000,clips:r});`
};

async function run(body, extra) {
  const raw = await callBridge('evalJson', [wrap(body, extra)], { timeoutMs: 120000 });
  const res = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (res && res.error) throw new Error(`${JSON.stringify(res)}`);
  return res;
}

// A bridge timeout does not stop the edit inside Premiere. The steps are
// idempotent, so the answer to a timeout is: wait, then run the step again.
// The panel's bridge reports it in Russian («ExtendScript не ответил за 30с»).
const isTimeout = (e) => /timeout|timed out|не ответил/i.test(String(e));
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

async function loop(name) {
  for (let pass = 1; pass <= 120; pass++) {
    let r;
    try { r = await run(BODY[name], `var B=${BATCH};`); }
    catch (e) {
      if (isTimeout(e)) { console.error(`  ${name}: bridge timeout, re-checking`); await pause(8000); continue; }
      throw e;
    }
    console.error(`  ${name} pass ${pass}: moved ${r.moved}, remaining ${r.remaining}`);
    if (r.remaining === 0) return;
    if (r.moved === 0) throw new Error(`${name} stalled: ${JSON.stringify(r.stillInside || r)}`);
  }
  throw new Error(`${name}: did not converge`);
}

async function main() {
  const steps = step === 'all' ? ['razor', 'lift', 'park', 'place', 'dump'] : [step];
  for (const st of steps) {
    if (st === 'razor') {
      const T = [...new Set(plan.razor)].sort((a, b) => a - b);
      for (let i = 0; i < T.length; i += 8) {
        let r;
        // razoring an existing cut again is a no-op, so a timed-out batch is simply repeated
        for (;;) {
          try { r = await run(BODY.razor, `var T=${JSON.stringify(T.slice(i, i + 8))};`); break; }
          catch (e) { if (!isTimeout(e)) throw e; console.error('  razor: bridge timeout, re-checking'); await pause(8000); }
        }
        console.error(`  razor ${i + 1}-${Math.min(i + 8, T.length)}/${T.length}: ${r.razored} cuts, ${r.fails} fails` +
          (r.stillSpanning.length ? `, STILL SPANNING ${r.stillSpanning.join(' ')}` : ''));
        if (r.stillSpanning.length) throw new Error('razor left clips spanning a cut point');
      }
    } else if (st === 'lift' || st === 'park' || st === 'place') {
      await loop(st);
    } else if (st === 'test-move') {
      console.log(JSON.stringify(await run(BODY['test-move'])));
    } else if (st === 'dump') {
      const r = await run(BODY.dump);
      const out = arg('out');
      if (out) writeFileSync(out, JSON.stringify(r, null, 1));
      console.error(`  dump: ${r.clips.length} clips, sequence end ${r.end}`);
    } else throw new Error(`unknown step ${st}`);
  }
}
main().catch(e => { console.error('ERROR', e.message); process.exit(1); });
