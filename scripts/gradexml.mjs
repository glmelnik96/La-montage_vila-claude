// A grading timeline for DaVinci: the V1 video of the episodes (no stills, no audio, no Motion),
// one sequence per project, exported as FCP XML (references/grade-roundtrip.md). Two modes:
//   all      every V1 piece as it is used, each episode at its own offset (gaps kept)
//   visible  only the parts of V1 not under a full-frame still (png/jpg on V2+), packed with 1 s gaps
// Episodes follow each other with >= 5 s between them and a marker «Ролик N» at each start.
//   node scripts/gradexml.mjs --expect <path part> --dump <seqdump.json> --seqs "Ролик 1,..."
//        --mode all|visible --name "<grading sequence>" --xml "<out.xml>" --plan "<plan.json>"
//        --step plan|prepare|place|check|export|all
// Check the XML itself afterwards: python scripts/gradexmlcheck.py <out.xml> <plan.json>.
// V1 must carry default Motion and no effects (a punch-in would be baked into the grade): look first.
// Placement: the source project item's in/out marks are set for the overwrite and restored after.
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { callBridge } from './lib/prbridge.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const EXPECT = arg('expect'), DUMP = arg('dump'), SEQS = String(arg('seqs', '')).split(',').filter(Boolean);
const MODE = arg('mode'), NAME = arg('name'), XML = arg('xml'), PLAN = arg('plan'), STEP = arg('step'), B = +arg('batch', 8);
if (!EXPECT || !DUMP || !SEQS.length || !['all', 'visible'].includes(MODE) || !NAME || !XML || !PLAN || !STEP) { console.error('missing args'); process.exit(2); }
const F = 0.04, r2 = (x) => Math.round(x * 100) / 100, grid = (x) => Math.round(x / F) * F;

// ---- plan
function makePlan() {
  const dump = JSON.parse(readFileSync(DUMP, 'utf8'));
  if (!dump.project.includes(EXPECT)) throw new Error('dump is of ' + dump.project);
  const rows = [], marks = [];
  let offset = 0;
  for (const ep of SEQS) {
    const s = dump.seqs.find((x) => x.name === ep);
    const cover = s.v.slice(1).flat().filter((c) => /\.(png|jpe?g)$/i.test(c[0])).map((c) => [c[1], c[2]]).sort((a, b) => a[0] - b[0]);
    const frags = [];
    s.v[0].forEach((c, q) => {
      const [name, st, en, sIn] = c;
      let segs = [[st, en]];
      if (MODE === 'visible') for (const [x, y] of cover) segs = segs.flatMap(([a, b]) => (y <= a || x >= b) ? [[a, b]] : [...(x > a ? [[a, x]] : []), ...(y < b ? [[y, b]] : [])]);
      for (const [a, b] of segs) if (b - a >= F - 1e-6) frags.push({ ep, q, name, a: r2(a), b: r2(b), sIn: r2(sIn + (a - st)) });
    });
    let cur = 0;
    for (const f of frags) {
      const d = r2(f.b - f.a);
      const gs = MODE === 'all' ? r2(offset + f.a) : r2(offset + cur);
      rows.push({ ...f, gs, ge: r2(gs + d), id: `${ep.replace('Ролик ', 'R')}_${String(rows.filter((x) => x.ep === ep).length + 1).padStart(2, '0')}` });
      cur = r2(cur + d + 1);
    }
    const len = MODE === 'all' ? s.end : Math.max(0, cur - 1);
    marks.push({ t: offset, name: ep, comment: `${frags.length} фрагм., ${r2(frags.reduce((n, f) => n + f.b - f.a, 0))} с видео; в ролике ${s.end} с` });
    offset = Math.ceil(offset + len + 5);
  }
  return { mode: MODE, project: EXPECT, name: NAME, xml: XML, rows, marks, total: r2(rows.reduce((n, f) => n + f.ge - f.gs, 0)) };
}

const HEAD = `var p=app.project, i, t, q, k;
  if(String(p.path).indexOf(${JSON.stringify(EXPECT)})<0) return JSON.stringify({error:'focused project is '+p.path});
  function seqNamed(nm){ for(var j=0;j<p.sequences.numSequences;j++){ if(String(p.sequences[j].name)===nm) return p.sequences[j]; } return null; }
  function R(x){ return Math.round(x*1000)/1000; }
  function tm(x){ var o=new Time(); o.seconds=x; return o; }`;
async function run(body, opts = {}) {
  const raw = await callBridge('evalJson', [`(function(){ try { ${HEAD} ${body} } catch(e){ return JSON.stringify({error:String(e), line:e.line}); } })()`], { timeoutMs: 110000, ...opts });
  const r = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (r && r.error) throw new Error(JSON.stringify(r));
  return r;
}
const isTimeout = (e) => /timeout|timed out|не ответил/i.test(String(e));
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

const steps = {
  async plan() {
    const pl = makePlan();
    writeFileSync(PLAN, JSON.stringify(pl, null, 1));
    const byEp = {};
    for (const r of pl.rows) (byEp[r.ep] ||= []).push(r);
    for (const m of pl.marks) console.log(`  ${m.name} @${m.t}: ${m.comment}`);
    console.log(`plan ${MODE}: ${pl.rows.length} fragments, ${(pl.total / 60).toFixed(1)} min of video, timeline ends ${pl.rows.at(-1).ge} s -> ${PLAN}`);
  },
  async prepare() {
    const r = await run(`var G=seqNamed(${JSON.stringify(NAME)});
      if(!G){ var S=seqNamed(${JSON.stringify(SEQS[0])}); if(!S) return JSON.stringify({error:'no '+${JSON.stringify(SEQS[0])}});
        var before={}; for(i=0;i<p.sequences.numSequences;i++) before[String(p.sequences[i].sequenceID)]=1;
        S.clone(); for(i=0;i<p.sequences.numSequences;i++){ if(!before[String(p.sequences[i].sequenceID)]) G=p.sequences[i]; }
        if(!G) return JSON.stringify({error:'clone not found'}); G.name=${JSON.stringify(NAME)}; }
      p.openSequence(G.sequenceID); var s=p.activeSequence;
      if(String(s.sequenceID)!==String(G.sequenceID)) return JSON.stringify({error:'not active'});
      var n=0;
      for(t=0;t<s.videoTracks.numTracks;t++){ var tr=s.videoTracks[t]; while(tr.clips.numItems>0 && n<60){ tr.clips[tr.clips.numItems-1].remove(0,1); n++; } }
      for(t=0;t<s.audioTracks.numTracks;t++){ var ta=s.audioTracks[t]; while(ta.clips.numItems>0 && n<60){ ta.clips[ta.clips.numItems-1].remove(0,1); n++; } }
      var left=0; for(t=0;t<s.videoTracks.numTracks;t++) left+=s.videoTracks[t].clips.numItems; for(t=0;t<s.audioTracks.numTracks;t++) left+=s.audioTracks[t].clips.numItems;
      var m=s.markers, mk=m.getFirstMarker(), dm=0; while(mk){ var nx=m.getNextMarker(mk); m.deleteMarker(mk); dm++; mk=nx; }
      s.setInPoint(0);
      return JSON.stringify({seq:String(s.name), removed:n, left:left, markersRemoved:dm});`);
    console.log('prepare', JSON.stringify(r));
    if (r.left) return steps.prepare();
  },
  async place() {
    const pl = JSON.parse(readFileSync(PLAN, 'utf8'));
    const rows = pl.rows.slice().sort((a, b) => a.gs - b.gs);
    for (let pass = 1; pass <= 100; pass++) {
      let r;
      try {
        r = await run(`var P=${JSON.stringify(rows)}, s=p.activeSequence;
          if(String(s.name)!==${JSON.stringify(NAME)}) return JSON.stringify({error:'active is '+s.name});
          var V=s.videoTracks[0], n=0, rem=0, note=[];
          function at(tr,t0,nm){ for(var j=0;j<tr.clips.numItems;j++){ var c=tr.clips[j]; if(Math.abs(c.start.seconds-t0)<0.02 && String(c.name)===nm) return c; } return null; }
          for(k=0;k<P.length;k++){ var e=P[k], d=e.ge-e.gs;
            var have=at(V,e.gs,e.name);
            if(have && Math.abs(have.inPoint.seconds-e.sIn)<0.02 && Math.abs(have.end.seconds-e.ge)<0.02) continue;
            if(n>=${B}){ rem++; continue; }
            var S=seqNamed(e.ep), src=S.videoTracks[0].clips[e.q];
            if(String(src.name)!==e.name){ note.push(e.id+': V1['+e.q+'] is '+src.name); n++; continue; }
            var pi=src.projectItem, oi=null, oo=null;
            try{ oi=pi.getInPoint(); oo=pi.getOutPoint(); }catch(e0){}
            pi.setInPoint(e.sIn+0.001,4); pi.setOutPoint(e.sIn+d+0.001,4);
            V.overwriteClip(pi, e.gs+0.001);
            try{ if(oi&&oo){ pi.setInPoint(oi.seconds,4); pi.setOutPoint(oo.seconds,4); } else { pi.clearInPoint(); pi.clearOutPoint(); } }catch(e1){}
            var v=at(V,e.gs,e.name);
            if(!v){ note.push(e.id+' not placed'); n++; continue; }
            if(Math.abs(v.end.seconds-e.ge)>=0.02){ v.outPoint=tm(e.sIn+d+0.001); v.end=tm(e.ge+0.001); }
            for(t=0;t<s.audioTracks.numTracks;t++){ var a=at(s.audioTracks[t],e.gs,e.name); if(a) a.remove(0,0); }
            n++; }
          return JSON.stringify({done:n, remaining:rem, note:note});`);
      } catch (e) {
        if (isTimeout(e)) { console.error('  place: bridge timeout, re-checking'); await pause(8000); continue; }
        throw e;
      }
      console.error(`  place pass ${pass}: done ${r.done}, remaining ${r.remaining}${r.note.length ? ' NOTES ' + r.note.join('; ') : ''}`);
      if (r.note.length) throw new Error('placement notes');
      if (r.remaining === 0) break;
    }
    const m = await run(`var s=p.activeSequence; if(String(s.name)!==${JSON.stringify(NAME)}) return JSON.stringify({error:'active is '+s.name});
      var M=${JSON.stringify(pl.marks)}, mm=s.markers, have={}, x=mm.getFirstMarker();
      while(x){ have[String(x.name)+'@'+R(x.start.seconds)]=1; x=mm.getNextMarker(x); }
      var made=0; for(k=0;k<M.length;k++){ if(have[M[k].name+'@'+R(M[k].t)]) continue; var nm=mm.createMarker(M[k].t); nm.name=M[k].name; nm.comments=M[k].comment; made++; }
      var end=0; var V=s.videoTracks[0]; for(k=0;k<V.clips.numItems;k++) if(V.clips[k].end.seconds>end) end=V.clips[k].end.seconds;
      s.setInPoint(0); s.setOutPoint(end);
      return JSON.stringify({markers:made, out:end});`);
    console.log('place: markers', m.markers, 'out', m.out);
  },
  async check() {
    const pl = JSON.parse(readFileSync(PLAN, 'utf8'));
    const r = await run(`var G=seqNamed(${JSON.stringify(NAME)}), o={v:[], a:0, v2:0, m:0};
      for(t=0;t<G.videoTracks.numTracks;t++){ var tr=G.videoTracks[t]; for(q=0;q<tr.clips.numItems;q++){ var c=tr.clips[q];
        if(t===0) o.v.push([String(c.name), R(c.start.seconds), R(c.end.seconds), R(c.inPoint.seconds)]); else o.v2++; } }
      for(t=0;t<G.audioTracks.numTracks;t++) o.a+=G.audioTracks[t].clips.numItems;
      var x=G.markers.getFirstMarker(); while(x){ o.m++; x=G.markers.getNextMarker(x); }
      return JSON.stringify(o);`, { mutating: false });
    const want = pl.rows.slice().sort((a, b) => a.gs - b.gs);
    const errs = [];
    if (r.v.length !== want.length) errs.push(`${r.v.length} clips on V1, plan ${want.length}`);
    want.forEach((w, k) => { const g = r.v[k]; if (!g || g[0] !== w.name || Math.abs(g[1] - w.gs) > 0.011 || Math.abs(g[2] - w.ge) > 0.011 || Math.abs(g[3] - w.sIn) > 0.011) errs.push(`${w.id}: want ${w.name} ${w.gs}-${w.ge} in ${w.sIn}, got ${g ? g.join(' ') : 'nothing'}`); });
    if (r.a) errs.push(`${r.a} audio clips`);
    if (r.v2) errs.push(`${r.v2} clips above V1`);
    if (r.m !== pl.marks.length) errs.push(`${r.m} markers, plan ${pl.marks.length}`);
    console.log(`check ${NAME}: ${r.v.length} clips, ${errs.length ? 'MISMATCH ' + errs.slice(0, 6).join(' ; ') : 'V1 exactly as planned, no audio, nothing above V1, markers in place'}`);
    if (errs.length) process.exit(1);
  },
  async export() {
    const r = await run(`var G=seqNamed(${JSON.stringify(NAME)}); if(!G) return JSON.stringify({error:'no sequence'});
      var ok=G.exportAsFinalCutProXML(new File(${JSON.stringify(XML)}).fsName, 1);
      return JSON.stringify({ok:String(ok)});`);
    for (let w = 0; w < 30 && !(existsSync(XML) && statSync(XML).size > 1000); w++) await pause(500);
    console.log('export', JSON.stringify(r), existsSync(XML) ? `${statSync(XML).size} bytes -> ${XML}` : 'NO FILE');
    if (!existsSync(XML)) process.exit(1);
  },
};
const order = STEP === 'all' ? ['plan', 'prepare', 'place', 'check', 'export'] : [STEP];
for (const st of order) await steps[st]();
