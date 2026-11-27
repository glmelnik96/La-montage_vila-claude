// A grading timeline for DaVinci: the V1 video of the episodes (no stills, no audio, no Motion),
// one sequence per project, exported as FCP XML (references/grade-roundtrip.md). Two modes:
//   all      every V1 piece as it is used, each episode at its own offset (gaps kept)
//   visible  only the parts of V1 not under a full-frame still (png/jpg on V2+), packed with 1 s gaps
// Episodes follow each other with >= 5 s between them and a marker «Ролик N» at each start.
//   node scripts/gradexml.mjs --expect <path part> --dump <seqdump.json> --seqs "Ролик 1,..."
//        --mode all|visible --name "<grading sequence>" --xml "<out.xml>" --plan "<plan.json>"
//        --step plan|prepare|place|check|export|all
//        [--tracks 1,2] [--media "\.braw$"] [--pack <gap s>] [--source-size] [--bin "<root bin>"] [--copy-markers]
//        [--fps 50] [--size-from "<clip name>"] [--min <s>] [--ranges <ranges.json>]
// --tracks    the camera sits on several tracks (a speaker window on V2 over a screen on V1): take the pieces of
//             all of them. They land on V1 of the grading timeline, so in `all` mode they must not overlap.
// --media     keep only the clips whose media path matches (screen recordings and stills on the same tracks).
// --pack      lay the pieces one after another in the edit's order with this gap (`visible` always packs, 1 s),
//             instead of at their times in the episode. The Copilot course user asked for this (2026-10-27).
// --source-size  build the grading sequence from the first piece's own media, so it has the camera's frame
//             (a UHD camera in a 1080p edit) instead of cloning the episode.
// --copy-markers  carry the episode's own markers (its blocks) over too, for finding one's way in Resolve; packed,
//             each goes to its block's first piece, and a block with no piece (a full-screen card) gets none.
// --fps       the grading timeline's rate (default 25). A slowed clip of a 50p camera in a 25p edit shows every
//             source frame, and a 25p grading timeline would render only every other one: grade it at 50.
// --size-from with --source-size: the clip whose media makes the sequence (default the first piece). Pick a
//             square-pixel camera clip, not an anamorphic or a phone one.
// --min       the shortest piece in seconds (default one frame): a near-freeze (speed 1 %) uses a sliver of source.
// --ranges    {"<track>:<index>": [s0, s1]} source ranges that replace the computed ones: a clip with Time Remapping
//             (a speed ramp) reports speed 1 and shows other frames than its in/out say; the DOM has no trace of
//             the remap. Read its range off a render of the edit (the frames it shows), with a margin.
// Speed and reverse (seqdump fields 7, 8): every piece goes to the grading timeline at 100 %, over the source range
// the edit shows: in*speed .. out*speed; reversed, mirrored from the media's end (ffprobe) with one edit frame of
// margin, as Premiere 26.5 maps it. A transition that reaches past a clip's edge (a dissolve at a cut) extends the
// piece by the frames it borrows. Rows keep speed, reverse and the extension for the substitution.
// Check the XML itself afterwards: python scripts/gradexmlcheck.py <out.xml> <plan.json>.
// The camera pieces' Motion and effects are NOT carried: the grade is of the whole frame, and the substitution
// keeps each piece's own Motion. Look at them first anyway (a crop or a key the substitution must keep).
// Placement: the source project item's in/out marks are set for the overwrite and restored after.
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { callBridge } from './lib/prbridge.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const EXPECT = arg('expect'), DUMP = arg('dump'), SEQS = String(arg('seqs', '')).split(',').filter(Boolean);
const MODE = arg('mode'), NAME = arg('name'), XML = arg('xml'), PLAN = arg('plan'), STEP = arg('step'), B = +arg('batch', 8);
const TRACKS = String(arg('tracks', '1')).split(',').map((x) => +x - 1), MEDIA = arg('media') ? new RegExp(arg('media'), 'i') : null;
const SOURCE_SIZE = process.argv.includes('--source-size'), COPY_MARKERS = process.argv.includes('--copy-markers'), BIN = arg('bin', '');
const PACK = arg('pack') !== undefined ? +arg('pack') : (MODE === 'visible' ? 1 : null);
const GFPS = +arg('fps', 25), SIZE_FROM = arg('size-from', '');
const RANGES = arg('ranges') ? JSON.parse(readFileSync(arg('ranges'), 'utf8')) : {};
if (!EXPECT || !DUMP || !SEQS.length || !['all', 'visible'].includes(MODE) || !NAME || !XML || !PLAN || !STEP) { console.error('missing args'); process.exit(2); }
const F = 1 / GFPS, MIN = +arg('min', F), r2 = (x) => Math.round(x * 1000) / 1000;
const up = (x) => Math.ceil(x / F - 1e-6) * F, down = (x) => Math.floor(x / F + 1e-6) * F;
const probes = {};
function probeMedia(path) {
  // ffprobe cannot read some camera formats (BRAW): then the length and rate are unknown, which only a reversed
  // clip needs
  if (!(path in probes)) {
    try {
      const j = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'format=duration:stream=r_frame_rate', '-of', 'json', path], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
      const [n, d] = j.streams[0].r_frame_rate.split('/').map(Number);
      probes[path] = { dur: +j.format.duration, fps: n / d };
    } catch (e) { probes[path] = { dur: null, fps: null }; }
  }
  return probes[path];
}
const mediaDur = (path) => probeMedia(path).dur;

// ---- plan
function makePlan() {
  const dump = JSON.parse(readFileSync(DUMP, 'utf8'));
  if (!dump.project.includes(EXPECT)) throw new Error('dump is of ' + dump.project);
  const rows = [], marks = [];
  let offset = 0;
  for (const ep of SEQS) {
    const s = dump.seqs.find((x) => x.name === ep);
    const frags = [];
    for (const tr of TRACKS) {
      // a still on a track above the piece's own hides it
      const cover = s.v.slice(tr + 1).flat().filter((c) => /\.(png|jpe?g)$/i.test(c[0])).map((c) => [c[1], c[2]]).sort((a, b) => a[0] - b[0]);
      const trans = (s.vt || [])[tr] || [];
      (s.v[tr] || []).forEach((c, q) => {
        const [name, st, en, sIn] = c, sp = c[7] || 1, rev = !!c[8];
        if (MEDIA && !MEDIA.test(c[5] || '')) return;
        let segs = [[st, en]];
        if (MODE === 'visible') for (const [x, y] of cover) segs = segs.flatMap(([a, b]) => (y <= a || x >= b) ? [[a, b]] : [...(x > a ? [[a, x]] : []), ...(y < b ? [[y, b]] : [])]);
        for (const [a, b] of segs) {
          if (b - a < (s.fd || 0.04) - 1e-6) continue;
          // timeline borrowed by a transition across this piece's edge, before its head and after its tail
          const head = a === st ? Math.max(0, ...trans.filter(([x, y]) => x < st - 1e-6 && y > st - 1e-6).map(([x]) => st - x)) : 0;
          const tail = b === en ? Math.max(0, ...trans.filter(([x, y]) => x < en + 1e-6 && y > en + 1e-6).map(([, y]) => y - en)) : 0;
          const i0 = sIn + (a - st), i1 = i0 + (b - a);                       // stretched time of the piece
          let s0, s1, D = mediaDur(c[5]), over = RANGES[`${tr + 1}:${q}`];
          if (rev && !over && D === null) throw new Error(`V${tr + 1}[${q}] ${name} is reversed and ffprobe cannot read its length: pass --ranges`);
          if (over) [s0, s1] = over;
          else if (!rev) { s0 = (i0 - head) * sp; s1 = (i1 + tail) * sp; }
          else { s0 = D - (i1 + tail) * sp - (s.fd || 0.04); s1 = D - (i0 - head) * sp; }
          const sf0 = probeMedia(c[5]).fps;
          if (sf0 && Math.abs(sf0 - GFPS) > 0.01) { s0 -= 1 / sf0; s1 += 1 / sf0; }   // it lands on its own frames: one more each side
          s0 = Math.max(0, down(s0)); s1 = D === null ? up(s1) : Math.min(up(s1), down(D));
          if ((D !== null && s1 > D + 1e-6) || s0 >= s1) throw new Error(`V${tr + 1}[${q}] ${name}: source ${r2(s0)}-${r2(s1)} is not inside the file (0-${r2(D)}): Time Remapping? pass --ranges`);
          if (s1 - s0 < MIN - 1e-6) s1 = s0 + up(MIN);
          // a source of another rate lands on its own frame, then on the sequence's grid: up to one of each off
          const sf = probeMedia(c[5]).fps || GFPS, tol = r2((Math.abs(sf - GFPS) > 0.01 ? 1 / sf + F : F / 2) + 0.001);
          frags.push({ ep, tr, q, name, path: c[5], a: r2(a), b: r2(b), sIn: r2(s0), sd: r2(s1 - s0), sp, rev: rev ? 1 : 0, head: r2(head), tail: r2(tail), remap: over ? 1 : 0, tol });
        }
      });
    }
    frags.sort((x, y) => x.a - y.a || x.tr - y.tr);
    if (PACK === null) frags.forEach((f, k) => { if (k && f.a < frags[k - 1].b - 1e-6) throw new Error(`${ep}: V${frags[k - 1].tr + 1} ${frags[k - 1].a}-${frags[k - 1].b} and V${f.tr + 1} ${f.a}-${f.b} overlap: they cannot share V1`); });
    if (PACK === null && frags.some((f) => Math.abs(f.sd - (f.b - f.a)) > F / 2)) throw new Error(`${ep}: speed-changed pieces need --pack: at 100 % they no longer fit their places`);
    let cur = 0;
    for (const f of frags) {
      const d = f.sd;
      const gs = PACK === null ? r2(offset + f.a) : r2(offset + cur);
      rows.push({ ...f, gs, ge: r2(gs + d), id: `${ep.replace('Ролик ', 'R')}_${String(rows.filter((x) => x.ep === ep).length + 1).padStart(2, '0')}` });
      cur = r2(cur + d + (PACK || 0));
    }
    for (const f of rows.filter((x) => x.ep === ep && (x.sp !== 1 || x.rev || x.head || x.tail || x.remap)))
      console.log(`  ${f.id} V${f.tr + 1} ${f.a}-${f.b} ${f.name}: speed ${Math.round(f.sp * 100)} %${f.rev ? ', reversed' : ''}${f.remap ? ', Time Remapping (range from its frames)' : ''}${f.head || f.tail ? `, transition +${f.head}/+${f.tail} s` : ''} -> source ${f.sIn}-${r2(f.sIn + f.sd)} at 100 %`);
    const len = PACK === null ? s.end : Math.max(0, cur - (PACK || 0));
    marks.push({ t: offset, name: ep, comment: `${frags.length} фрагм., ${r2(frags.reduce((n, f) => n + f.b - f.a, 0))} с видео; в ролике ${s.end} с` });
    if (COPY_MARKERS) {
      const ms = (s.markers || []).slice().sort((x, y) => x[0] - y[0]), mine = rows.filter((x) => x.ep === ep);
      ms.forEach((m, k) => {
        if (PACK === null) { marks.push({ t: r2(offset + m[0]), name: m[2], comment: m[3] || '' }); return; }
        const nx = k + 1 < ms.length ? ms[k + 1][0] : Infinity, f = mine.find((x) => x.a >= m[0] - 0.01 && x.a < nx - 0.01);
        if (f) marks.push({ t: f.gs, name: m[2], comment: `${m[3] ? m[3] + '; ' : ''}в ролике с ${m[0]} с` });
      });
    }
    offset = Math.ceil(offset + len + 5);
  }
  return { mode: MODE, project: EXPECT, name: NAME, xml: XML, fps: GFPS, rows, marks, total: r2(rows.reduce((n, f) => n + f.ge - f.gs, 0)) };
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
    const rows0 = JSON.parse(readFileSync(PLAN, 'utf8')).rows.slice().sort((a, b) => a.gs - b.gs);
    const first = rows0.find((x) => SIZE_FROM && x.name === SIZE_FROM) || rows0[0];
    const r = await run(`var G=seqNamed(${JSON.stringify(NAME)});
      if(!G){ var S=seqNamed(${JSON.stringify(SEQS[0])}); if(!S) return JSON.stringify({error:'no '+${JSON.stringify(SEQS[0])}});
        if(${SOURCE_SIZE}){ var src=S.videoTracks[${first.tr || 0}].clips[${first.q}];
          if(String(src.name)!==${JSON.stringify(first.name)}) return JSON.stringify({error:'first piece is '+src.name});
          G=p.createNewSequenceFromClips(${JSON.stringify(NAME)}, [src.projectItem], p.rootItem);
          if(!G) return JSON.stringify({error:'createNewSequenceFromClips gave nothing'}); }
        else { var before={}; for(i=0;i<p.sequences.numSequences;i++) before[String(p.sequences[i].sequenceID)]=1;
          S.clone(); for(i=0;i<p.sequences.numSequences;i++){ if(!before[String(p.sequences[i].sequenceID)]) G=p.sequences[i]; }
          if(!G) return JSON.stringify({error:'clone not found'}); }
        G.name=${JSON.stringify(NAME)};
        if(${JSON.stringify(BIN)}){ for(i=0;i<p.rootItem.children.numItems;i++){ var b=p.rootItem.children[i];
          if(b.type===2 && String(b.name)===${JSON.stringify(BIN)}){ try{ G.projectItem.moveBin(b); }catch(eb){} } } } }
      p.openSequence(G.sequenceID); var s=p.activeSequence;
      if(String(s.sequenceID)!==String(G.sequenceID)) return JSON.stringify({error:'not active'});
      var n=0, st=s.getSettings(), fr=Math.round(1/st.videoFrameRate.seconds*1000)/1000;
      if(Math.abs(fr-${GFPS})>0.01) return JSON.stringify({error:'the grading sequence runs at '+fr+' fps, not ${GFPS}: pick another --size-from'});
      for(t=0;t<s.videoTracks.numTracks;t++){ var tr=s.videoTracks[t]; while(tr.clips.numItems>0 && n<60){ tr.clips[tr.clips.numItems-1].remove(0,1); n++; } }
      for(t=0;t<s.audioTracks.numTracks;t++){ var ta=s.audioTracks[t]; while(ta.clips.numItems>0 && n<60){ ta.clips[ta.clips.numItems-1].remove(0,1); n++; } }
      var left=0; for(t=0;t<s.videoTracks.numTracks;t++) left+=s.videoTracks[t].clips.numItems; for(t=0;t<s.audioTracks.numTracks;t++) left+=s.audioTracks[t].clips.numItems;
      var m=s.markers, mk=m.getFirstMarker(), dm=0; while(mk){ var nx=m.getNextMarker(mk); m.deleteMarker(mk); dm++; mk=nx; }
      s.setInPoint(0);
      return JSON.stringify({seq:String(s.name), w:st.videoFrameWidth, h:st.videoFrameHeight, fps:fr, par:String(st.videoPixelAspectRatio), removed:n, left:left, markersRemoved:dm});`);
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
          var note2=[], V=s.videoTracks[0], n=0, rem=0, note=[], H=${F / 2};
          function at(tr,t0,nm){ for(var j=0;j<tr.clips.numItems;j++){ var c=tr.clips[j]; if(Math.abs(c.start.seconds-t0)<H && String(c.name)===nm) return c; } return null; }
          for(k=0;k<P.length;k++){ var e=P[k], d=e.ge-e.gs;
            var have=at(V,e.gs,e.name);
            if(have && Math.abs(have.inPoint.seconds-e.sIn)<e.tol && Math.abs(have.end.seconds-e.ge)<H) continue;
            if(n>=${B}){ rem++; continue; }
            var S=seqNamed(e.ep), src=S.videoTracks[e.tr||0].clips[e.q];
            if(String(src.name)!==e.name){ note.push(e.id+': V1['+e.q+'] is '+src.name); n++; continue; }
            var pi=src.projectItem, oi=null, oo=null;
            try{ oi=pi.getInPoint(); oo=pi.getOutPoint(); }catch(e0){}
            pi.setInPoint(e.sIn+0.001,4); pi.setOutPoint(e.sIn+d+0.001,4);
            V.overwriteClip(pi, e.gs+0.001);
            try{ if(oi&&oo){ pi.setInPoint(oi.seconds,4); pi.setOutPoint(oo.seconds,4); } else { pi.clearInPoint(); pi.clearOutPoint(); } }catch(e1){}
            var v=at(V,e.gs,e.name);
            if(!v){ note.push(e.id+' not placed'); n++; continue; }
            if(Math.abs(v.end.seconds-e.ge)>=H){ v.outPoint=tm(e.sIn+d+0.001); v.end=tm(e.ge+0.001); }
            if(Math.abs(v.inPoint.seconds-e.sIn)>=e.tol) note.push(e.id+': placed with in '+R(v.inPoint.seconds)+', not '+e.sIn);
            for(q=0;q<v.components.numItems;q++){ var mo=v.components[q]; if(String(mo.displayName)!=='Motion') continue;
              var sc=mo.properties[1], was=sc.getValue(); if(Math.abs(was-100)>0.001){ sc.setValue(100,true); note2.push(e.id+' scale was '+R(was)); } }
            for(t=0;t<s.audioTracks.numTracks;t++){ var a=at(s.audioTracks[t],e.gs,e.name); if(a) a.remove(0,0); }
            n++; }
          return JSON.stringify({done:n, remaining:rem, note:note, note2:note2});`);
      } catch (e) {
        if (isTimeout(e)) { console.error('  place: bridge timeout, re-checking'); await pause(8000); continue; }
        throw e;
      }
      console.error(`  place pass ${pass}: done ${r.done}, remaining ${r.remaining}${r.note.length ? ' NOTES ' + r.note.join('; ') : ''}${r.note2.length ? ' (Motion reset: ' + r.note2.join('; ') + ')' : ''}`);
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
        if(t!==0){ o.v2++; continue; }
        var fx=[], sp=1, rv=0, sc=null, pos=null; try{ sp=c.getSpeed(); rv=c.isSpeedReversed()?1:0; }catch(e1){}
        for(k=0;k<c.components.numItems;k++){ var m=c.components[k], dn=String(m.displayName);
          if(dn==='Motion'){ sc=m.properties[1].getValue(); pos=String(m.properties[0].getValue()); } else if(dn!=='Opacity') fx.push(dn); }
        o.v.push([String(c.name), R(c.start.seconds), R(c.end.seconds), R(c.inPoint.seconds), sp, rv, sc, pos, fx.join(',')]); } }
      for(t=0;t<G.audioTracks.numTracks;t++) o.a+=G.audioTracks[t].clips.numItems;
      var x=G.markers.getFirstMarker(); while(x){ o.m++; x=G.markers.getNextMarker(x); }
      return JSON.stringify(o);`, { mutating: false });
    const want = pl.rows.slice().sort((a, b) => a.gs - b.gs);
    const errs = [];
    if (r.v.length !== want.length) errs.push(`${r.v.length} clips on V1, plan ${want.length}`);
    const H = F / 2 + 1e-3;
    want.forEach((w, k) => { const g = r.v[k]; if (!g || g[0] !== w.name || Math.abs(g[1] - w.gs) > H || Math.abs(g[2] - w.ge) > H || Math.abs(g[3] - w.sIn) > (w.tol || H)) errs.push(`${w.id}: want ${w.name} ${w.gs}-${w.ge} in ${w.sIn}, got ${g ? g.join(' ') : 'nothing'}`);
      else if (g[4] !== 1 || g[5] || Math.abs(g[6] - 100) > 0.001 || g[7] !== '0.5,0.5' || g[8]) errs.push(`${w.id}: speed ${g[4]}, reversed ${g[5]}, scale ${g[6]}, position ${g[7]}, effects «${g[8]}»`); });
    if (r.a) errs.push(`${r.a} audio clips`);
    if (r.v2) errs.push(`${r.v2} clips above V1`);
    if (r.m !== pl.marks.length) errs.push(`${r.m} markers, plan ${pl.marks.length}`);
    console.log(`check ${NAME}: ${r.v.length} clips, ${errs.length ? 'MISMATCH ' + errs.slice(0, 6).join(' ; ') : 'V1 exactly as planned, every piece at 100 %, Scale 100, centred, no effects; no audio, nothing above V1, markers in place'}`);
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
