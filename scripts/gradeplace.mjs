// Put graded renders into an edit whose clips change speed, run reversed, are rotated, ramped or dissolved: each
// original video item is replaced by its render at the same place, showing the same source frames, with the same speed
// and reverse, Motion, effects and transitions; its linked audio stays (references/grade-roundtrip.md, section 4b).
//   node scripts/gradeplace.mjs --expect <path part> --seq "<sequence>" --plan <grade_plan.json> --map <render_map.json>
//        --bin "<bin>" --tag "<backup suffix>" [--bake <bake.json> --bakedir <dir>] [--skip "<row id>,..."]
//        --step snapshot|fit|backup|import|place|fx|props|trans|check
// The map comes from scripts/gradematch.py (render frame k = source frame j0 + k); bake.json lists the rows played
// through Time Remapping, baked by scripts/gradebake.py (placed at 100 %, frame for frame).
// snapshot  every row's original item (ticks, speed, reverse, components with keys), the tracks' transitions, the source
//           frame counts, and a seqdump; works out each render's in/out and checks the render holds every frame the
//           edit shows there (a dissolve's borrowed frames included). Rows it does not hold are skipped and reported.
//           Refuses once the originals are gone.
// fit       for rows the render does not hold (a conform that came out early), slip the source by the fewest frames that
//           make the render hold the whole piece: same place and length, the frames shifted (the user asked for it on
//           2026-10-28 rather than a re-render). Forward clips only; the row keeps «slip» for the report.
// backup    a clone «_OLD_<sequence> (<tag>)», kept if it exists.
// import    the renders (and baked files) into <bin>; a render whose colour space differs from its camera source's
//           gets the source's as an override (Resolve tags Rec.709 Gamma 2.2 as transfer 4: Premiere then shifted the
//           graded code values by +5..7 levels; with the override they pass through).
// place     per row, one per call (QE serves stale lists): remove the original (DOM remove: the linked audio stays),
//           overwrite the render at 100 % for as long as it holds, QE setSpeed(speed, '', reversed) when it changes,
//           then in/out/end in ticks. Premiere 26.5 shows source s(t) = in*sp + (t-a)*sp, reversed
//           s(t) = D - in*sp - FD - (t-a)*sp, so in' = in - j0/(fps*sp), reversed in' = in + (n + j0 - D)/(fps*sp).
// fx        the original's video effects (a Lumetri) added through QE.
// props     Motion, Opacity and effect values set where they differ from the fresh item's (blobs that match are not
//           touched; 64-bit swatches cannot be set from a script), keys moved with the in-point. A render Resolve
//           rotated by a source's rotation flag takes the original Motion as it is: Premiere honours the flag too.
// trans     each transition the removal took is added again on the same edge, length and alignment (QE addTransition).
// check     every other item, the audio, the transitions, the markers and the end as before; each row a render at
//           its place with its in/out, speed, reverse and values.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { callBridge } from './lib/prbridge.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const EXPECT = arg('expect'), SEQ = arg('seq'), PLANP = arg('plan'), MAPP = arg('map'), BIN = arg('bin'), TAG = arg('tag'), STEP = arg('step');
const BAKEP = arg('bake'), BAKEDIR = arg('bakedir'), SKIP = new Set(String(arg('skip', '')).split(',').filter(Boolean));
if (!EXPECT || !SEQ || !PLANP || !MAPP || !BIN || !TAG || !STEP) { console.error('missing args'); process.exit(2); }
const SNAP = PLANP.replace(/\.json$/, '') + ' — снимок подстановки.json';
const DUMP0 = PLANP.replace(/\.json$/, '') + ' — до подстановки.json';
const DUMP1 = PLANP.replace(/\.json$/, '') + ' — после подстановки.json';
const TPS = 254016000000n;
const plan = JSON.parse(readFileSync(PLANP, 'utf8')), rmap = JSON.parse(readFileSync(MAPP, 'utf8'));
const bake = BAKEP ? Object.fromEntries(JSON.parse(readFileSync(BAKEP, 'utf8')).map((b) => [b.id, b])) : {};
const mapBy = Object.fromEntries(rmap.rows.map((r) => [r.id, r]));
const fwd = (p) => p.replace(/\\/g, '/');
const renderPath = (id) => bake[id] ? `${fwd(BAKEDIR)}/${bake[id].name}.mov` : `${fwd(rmap.renders)}/${mapBy[id].render}`;
const renderName = (id) => renderPath(id).split('/').pop();
const INTRINSIC = ['Opacity', 'Motion', 'Time Remapping'];

const HEAD = `var p=app.project, i, j, k, t, q;
  if(String(p.path).indexOf(${JSON.stringify(EXPECT)})<0) return JSON.stringify({error:'focused project is '+p.path});
  function seqNamed(nm){ for(var z=0;z<p.sequences.numSequences;z++){ if(String(p.sequences[z].name)===nm) return p.sequences[z]; } return null; }
  function binNamed(nm){ for(var z=0;z<p.rootItem.children.numItems;z++){ var b=p.rootItem.children[z]; if(b.type===2 && String(b.name)===nm) return b; } return null; }
  function fw(x){ return String(x).split(String.fromCharCode(92)).join('/').toLowerCase(); }
  function R(x){ return Math.round(x*10000)/10000; }
  function tk(x){ var o=new Time(); o.ticks=String(x); return o; }
  function at(tr,t0,nm){ for(var z=0;z<tr.clips.numItems;z++){ var c=tr.clips[z]; if(Math.abs(c.start.seconds-t0)<0.01 && (!nm || String(c.name)===nm)) return c; } return null; }
  function qeAt(ti,t0){ app.enableQE(); var qt=qe.project.getActiveSequence().getVideoTrackAt(ti); for(var z=0;z<qt.numItems;z++){ var x=qt.getItemAt(z); if(String(x.type)==='Clip' && Math.abs(parseFloat(x.start.secs)-t0)<0.01) return x; } return null; }
  function comps(c){ var o=[], a, b, kk, ks; for(a=0;a<c.components.numItems;a++){ var m=c.components[a], pr=[];
      for(b=0;b<m.properties.numItems;b++){ var P=m.properties[b], e={n:String(P.displayName)};
        try{ if(P.isTimeVarying()){ ks=P.getKeys(); var kv=[]; for(kk=0;kk<ks.length;kk++) kv.push([ks[kk].seconds, P.getValueAtKey(ks[kk])]); e.keys=kv; } else e.v=P.getValue(); }catch(x){ e.err=1; }
        pr.push(e); }
      o.push({dn:String(m.displayName), p:pr}); }
    return o; }
  var S=seqNamed(${JSON.stringify(SEQ)}); if(!S) return JSON.stringify({error:'no sequence'});`;
async function run(body, opts = {}) {
  const raw = await callBridge('evalJson', [`(function(){ try { ${HEAD} ${body} } catch(e){ return JSON.stringify({error:String(e), line:e.line}); } })()`], { timeoutMs: 110000, ...opts });
  const r = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (r && r.error) throw new Error(JSON.stringify(r));
  return r;
}
function dump(out) {
  execFileSync('node', [fileURLToPath(new URL('./seqdump.mjs', import.meta.url)), '--out', out, '--seqs', SEQ], { encoding: 'utf8' });
  const d = JSON.parse(readFileSync(out, 'utf8'));
  if (!d.project.includes(EXPECT)) throw new Error('dump of the wrong project: ' + d.project);
  return d.seqs.find((x) => x.name === SEQ);
}
// the first number: a file with a rotation flag adds a side-data field to the line («504,»)
const frames = (p) => parseInt(execFileSync('ffprobe', ['-v', 'error', '-count_packets', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', p], { encoding: 'utf8' }).trim(), 10);
function rat(x, maxD = 1000) { const d = BigInt(maxD), n = BigInt(Math.round(x * maxD)); const g = (a, b) => b ? g(b, a % b) : a; const k = g(n, d); return [n / k, d / k]; }
const fpsRat = (f) => Math.abs(f - 29.97) < 0.01 ? [30000n, 1001n] : Math.abs(f - 23.976) < 0.01 ? [24000n, 1001n] : Math.abs(f - 59.94) < 0.01 ? [60000n, 1001n] : [BigInt(Math.round(f)), 1n];
const fdiv = (a, b) => (a >= 0n ? a / b : -((-a + b - 1n) / b));   // floor for BigInt

const steps = {
  async snapshot() {
    if (existsSync(SNAP)) { console.log('snapshot kept:', SNAP); return; }
    const rows = plan.rows.map((r) => ({ id: r.id, tr: r.tr || 0, a: r.a, name: r.name }));
    const items = [];
    for (let i = 0; i < rows.length; i += 6) {
      const r = await run(`var P=${JSON.stringify(rows.slice(i, i + 6))}, o=[], bad=[];
        for(k=0;k<P.length;k++){ var c=at(S.videoTracks[P[k].tr], P[k].a, P[k].name); if(!c){ bad.push(P[k].id); continue; }
          var sp=1, rv=false; try{ sp=c.getSpeed(); rv=c.isSpeedReversed(); }catch(e1){}
          o.push({id:P[k].id, startT:String(c.start.ticks), endT:String(c.end.ticks), inT:String(c.inPoint.ticks), outT:String(c.outPoint.ticks), ins:c.inPoint.seconds, sp:sp, rev:rv?1:0, comps:comps(c)}); }
        return JSON.stringify({o:o, bad:bad});`, { mutating: false });
      if (r.bad.length) throw new Error(`no original item for ${r.bad.join(', ')}: already replaced? the snapshot is not written`);
      items.push(...r.o);
    }
    const tv = await run(`var o=[], FDT=String(S.getSettings().videoFrameRate.ticks);
      for(t=0;t<S.videoTracks.numTracks;t++){ var T=S.videoTracks[t]; for(k=0;k<T.transitions.numItems;k++){ var x=T.transitions[k]; o.push({tr:t, s:x.start.seconds, e:x.end.seconds, sT:String(x.start.ticks), eT:String(x.end.ticks), name:String(x.name)}); } }
      return JSON.stringify({trans:o, fdT:FDT});`, { mutating: false });
    const FDT = BigInt(tv.fdT), srcFrames = {}, out = [];
    for (const it of items) {
      const p = plan.rows.find((x) => x.id === it.id), m = mapBy[it.id];
      if (!(p.path in srcFrames)) srcFrames[p.path] = frames(p.path.replace(/^([A-Za-z]:)\\\\+/, '$1\\'));
      const [fN, fD] = fpsRat(m.fps), TPF = TPS * fD / fN;
      const [sN, sD] = rat(it.sp), a = BigInt(it.startT), b = BigInt(it.endT), ip = BigInt(it.inT), K = (b - a) / FDT;
      const Dfr = BigInt(srcFrames[p.path]), j0 = BigInt(m.j0), n = BigInt(m.frames);
      // frames borrowed by a dissolve across this item's head (it ends at the item's start) or tail
      const hd = tv.trans.filter((x) => x.tr === p.tr && Math.abs(x.e - p.a) < 0.01 && x.s < p.a - 0.01);
      const tl = tv.trans.filter((x) => x.tr === p.tr && Math.abs(x.s - p.b) < 0.01 && x.e > p.b + 0.01);
      const k0 = hd.length ? -((a - BigInt(hd[0].sT)) / FDT) : 0n, k1 = K + (tl.length ? (BigInt(tl[0].eT) - b) / FDT : 0n);
      let shown = [], inN, rin;
      if (bake[it.id]) {
        shown = bake[it.id].frames.map(BigInt); inN = 0n; rin = 0n;
      } else {
        for (let kk = k0; kk < k1; kk++) {
          if (!it.rev) shown.push(fdiv(ip * sN + kk * FDT * sN, sD * TPF));
          else shown.push(fdiv(Dfr * TPF * sD - ip * sN - FDT * sD - kk * FDT * sN, sD * TPF));
        }
        inN = !it.rev ? ip - j0 * TPF * sD / sN : ip + (n + j0 - Dfr) * TPF * sD / sN;
        rin = !it.rev ? inN * sN / sD : 0n;
      }
      const lo = shown.reduce((x, y) => (y < x ? y : x)), hi = shown.reduce((x, y) => (y > x ? y : x));
      const renderLen = bake[it.id] ? BigInt(bake[it.id].frames.length) * FDT : n * TPF;
      let L0 = (b - a) < renderLen - rin ? (b - a) : renderLen - rin; L0 = (L0 / FDT) * FDT;
      const covered = bake[it.id] ? true : lo >= j0 && hi <= j0 + n - 1n;
      out.push({ ...it, tr: p.tr, a: p.a, b: p.b, name: p.name, path: p.path, render: renderName(it.id), baked: !!bake[it.id], transpose: bake[it.id] ? null : m.transpose,
        spN: String(sN), spD: String(sD), inNT: String(inN), outNT: String(inN + (b - a)), rinT: String(rin), L0T: String(L0), covered,
        need: [String(lo), String(hi)], has: [String(j0), String(j0 + n - 1n)], srcFrames: String(Dfr) });
    }
    const before = dump(DUMP0);
    writeFileSync(SNAP, JSON.stringify({ seq: SEQ, fdT: tv.fdT, trans: tv.trans, rows: out }, null, 1));
    const bad = out.filter((x) => !x.covered);
    console.log(`snapshot: ${out.length} rows (${out.filter((x) => x.baked).length} baked), ${tv.trans.length} transitions, end ${before.end} -> ${SNAP}`);
    for (const x of bad) console.log(`  NOT HELD: ${x.id} ${x.name} at ${x.a}: the edit shows source frames ${x.need.join('-')}, the render holds ${x.has.join('-')} -> skipped`);
  },
  async fit() {
    const snap = JSON.parse(readFileSync(SNAP, 'utf8'));
    for (const x of snap.rows.filter((y) => !y.covered && !y.baked)) {
      if (x.rev) { console.log(`fit ${x.id}: reversed, not slipped`); continue; }
      const m = mapBy[x.id], [fN, fD] = fpsRat(m.fps), TPF = TPS * fD / fN, [sN, sD] = [BigInt(x.spN), BigInt(x.spD)];
      const lo = BigInt(x.need[0]), hi = BigInt(x.need[1]), h0 = BigInt(x.has[0]), h1 = BigInt(x.has[1]);
      if (hi - lo > h1 - h0) { console.log(`fit ${x.id}: the render is shorter than the piece`); continue; }
      const d = hi > h1 ? h1 - hi : h0 - lo;                     // source frames: negative = earlier
      const inN = BigInt(x.inNT) + d * TPF * sD / sN, b_a = BigInt(x.endT) - BigInt(x.startT);
      const rin = inN * sN / sD, renderLen = BigInt(m.frames) * TPF, FDT = BigInt(snap.fdT);
      let L0 = b_a < renderLen - rin ? b_a : renderLen - rin; L0 = (L0 / FDT) * FDT;
      Object.assign(x, { inNT: String(inN), outNT: String(inN + b_a), rinT: String(rin), L0T: String(L0), covered: true, slip: Number(d),
        need: [String(lo + d), String(hi + d)] });
      console.log(`fit ${x.id} ${x.name} at ${x.a}: slipped ${d} source frames (${(Number(d) / m.fps).toFixed(3)} s): shows ${lo + d}-${hi + d}, the render holds ${h0}-${h1}`);
    }
    writeFileSync(SNAP, JSON.stringify(snap, null, 1));
  },
  async backup() {
    const nm = `_OLD_${SEQ} (${TAG})`;
    const r = await run(`var K=seqNamed(${JSON.stringify(nm)}); if(K) return JSON.stringify({kept:String(K.name)});
      var before={}; for(i=0;i<p.sequences.numSequences;i++) before[String(p.sequences[i].sequenceID)]=1;
      S.clone(); var made=null; for(i=0;i<p.sequences.numSequences;i++){ if(!before[String(p.sequences[i].sequenceID)]) made=p.sequences[i]; }
      if(!made) return JSON.stringify({error:'clone not found'}); made.name=${JSON.stringify(nm)}; return JSON.stringify({made:String(made.name)});`);
    console.log('backup', JSON.stringify(r));
  },
  async import() {
    const snap = JSON.parse(readFileSync(SNAP, 'utf8'));
    const rows = snap.rows.filter((x) => x.covered && !SKIP.has(x.id));
    const L = rows.map((x) => ({ path: renderPath(x.id), src: x.name }));
    for (let i = 0; i < L.length; i += 12) {
      const r = await run(`var b=binNamed(${JSON.stringify(BIN)}); if(!b){ p.rootItem.createBin(${JSON.stringify(BIN)}); b=binNamed(${JSON.stringify(BIN)}); }
        var L=${JSON.stringify(L.slice(i, i + 12))}, have={}, todo=[], o=[];
        for(k=0;k<b.children.numItems;k++) have[fw(b.children[k].getMediaPath())]=b.children[k];
        for(k=0;k<L.length;k++){ var fp=new File(L[k].path).fsName; if(!have[fw(fp)]) todo.push(fp); }
        if(todo.length) p.importFiles(todo, true, b, false);
        for(k=0;k<b.children.numItems;k++) have[fw(b.children[k].getMediaPath())]=b.children[k];
        var srcs={}; function walk(bb){ for(var z=0;z<bb.children.numItems;z++){ var x=bb.children[z]; if(x.type===2){ if(String(x.name)!==${JSON.stringify(BIN)}) walk(x); } else srcs[String(x.name)]=x; } } walk(p.rootItem);
        for(k=0;k<L.length;k++){ var it=have[fw(new File(L[k].path).fsName)]; if(!it){ o.push('MISSING '+L[k].path); continue; }
          var sc=srcs[L[k].src], cs=it.getColorSpace(), want=sc?sc.getColorSpace():null, note='';
          if(want && (cs.transferCharacteristic!==want.transferCharacteristic || cs.primaries!==want.primaries)){ it.setOverrideColorSpace(want); note=' colour '+cs.name+' -> '+it.getColorSpace().name; }
          var fi=it.getFootageInterpretation(), sf=sc?sc.getFootageInterpretation():null;
          if(sf && Math.abs(fi.pixelAspectRatio-sf.pixelAspectRatio)>0.001) note+=' PAR '+R(fi.pixelAspectRatio)+' != source '+R(sf.pixelAspectRatio);
          if(note) o.push(String(it.name).slice(-16)+note); }
        return JSON.stringify({imported:todo.length, notes:o});`);
      console.log(`import ${i + 1}-${Math.min(i + 12, L.length)}: ${r.imported} new${r.notes.length ? '; ' + r.notes.join('; ') : ''}`);
    }
  },
  async place() {
    const snap = JSON.parse(readFileSync(SNAP, 'utf8'));
    let done = 0, skipped = 0;
    for (const x of snap.rows) {
      if (!x.covered || SKIP.has(x.id)) { skipped++; continue; }
      const sp = Number(x.spN) / Number(x.spD), speedy = x.spN !== x.spD || x.rev;
      const r = await run(`p.openSequence(S.sequenceID); var s=p.activeSequence; var T=s.videoTracks[${x.tr}], AT=s.audioTracks.numTracks-1;
        var have=at(T, ${x.a}, ${JSON.stringify(x.render)}); if(have) return JSON.stringify({kept:1, item:[R(have.start.seconds),R(have.end.seconds),String(have.inPoint.ticks)]});
        if(s.audioTracks[AT].clips.numItems>0) return JSON.stringify({error:'the last audio track is not empty'});
        var O=at(T, ${x.a}, ${JSON.stringify(x.name)}); if(!O) return JSON.stringify({error:'original gone and no render at ${x.a}'});
        if(String(O.start.ticks)!==${JSON.stringify(x.startT)} || String(O.end.ticks)!==${JSON.stringify(x.endT)}) return JSON.stringify({error:'original moved'});
        var b=binNamed(${JSON.stringify(BIN)}), pi=null; for(k=0;k<b.children.numItems;k++) if(String(b.children[k].name)===${JSON.stringify(x.render)}) pi=b.children[k];
        if(!pi) return JSON.stringify({error:'render not in bin'});
        O.remove(0,0);
        var rin=${Number(BigInt(x.rinT)) / Number(TPS)}, L0=${Number(BigInt(x.L0T)) / Number(TPS)};
        pi.setInPoint(rin+0.0001,4); pi.setOutPoint(rin+L0+0.0001,4); s.overwriteClip(pi, ${x.a}+0.001, ${x.tr}, AT);
        try{ pi.clearInPoint(); pi.clearOutPoint(); }catch(e1){}
        var A2=s.audioTracks[AT]; for(k=A2.clips.numItems-1;k>=0;k--) A2.clips[k].remove(0,0);
        var n=at(T, ${x.a}, ${JSON.stringify(x.render)}); if(!n) return JSON.stringify({error:'not placed'});
        var ret='';
        if(${speedy}){ var qi=qeAt(${x.tr}, ${x.a}); if(!qi) return JSON.stringify({error:'no QE item'}); ret=String(qi.setSpeed(${sp}, '', ${x.rev ? 'true' : 'false'}, false, false)); n=at(T, ${x.a}, ${JSON.stringify(x.render)}); }
        n.inPoint=tk(${JSON.stringify(x.inNT)}); n.outPoint=tk(${JSON.stringify(x.outNT)}); n.end=tk(${JSON.stringify(x.endT)});
        n=at(T, ${x.a}, ${JSON.stringify(x.render)}); var sp2=1, rv2=false; try{ sp2=n.getSpeed(); rv2=n.isSpeedReversed(); }catch(e2){}
        return JSON.stringify({ret:ret, item:[String(n.start.ticks), String(n.end.ticks), String(n.inPoint.ticks), String(n.outPoint.ticks), sp2, rv2?1:0]});`);
      if (r.kept) { done++; continue; }
      const [sT, eT, iT, oT, sp2, rv2] = r.item;
      const off = (u, v) => Math.abs(Number(BigInt(u) - BigInt(v)));
      const bad = sT !== x.startT || eT !== x.endT || off(iT, x.inNT) > 1e4 || off(oT, x.outNT) > 1e4 || Math.abs(sp2 - sp) > 1e-4 || rv2 !== x.rev;
      console.log(`${x.id.slice(-2)} V${x.tr + 1} ${x.a}-${x.b} ${x.name}${x.baked ? ' (baked)' : ''}: speed ${Math.round(sp2 * 100)} %${rv2 ? ' reversed' : ''}, in ${(Number(BigInt(iT)) / Number(TPS)).toFixed(4)}${bad ? '  <-- CHECK ' + JSON.stringify({ want: [x.startT, x.endT, x.inNT, x.outNT], got: r.item }) : ''}`);
      if (bad) throw new Error('placement differs from the plan');
      done++;
    }
    console.log(`place: ${done} rows in place, ${skipped} skipped`);
  },
  async fx() {
    const snap = JSON.parse(readFileSync(SNAP, 'utf8'));
    for (const x of snap.rows.filter((y) => y.covered && !SKIP.has(y.id))) {
      const want = x.comps.map((c) => c.dn).filter((n) => !INTRINSIC.includes(n));
      if (!want.length) continue;
      const r = await run(`p.openSequence(S.sequenceID); var T=S.videoTracks[${x.tr}], n=at(T, ${x.a}, ${JSON.stringify(x.render)}); if(!n) return JSON.stringify({error:'no render item'});
        var W=${JSON.stringify(want)}, has={}, need={}, added=0; for(k=0;k<n.components.numItems;k++){ var d=String(n.components[k].displayName); has[d]=(has[d]||0)+1; }
        var qi=qeAt(${x.tr}, ${x.a});
        for(k=0;k<W.length;k++){ need[W[k]]=(need[W[k]]||0)+1; if((has[W[k]]||0)>=need[W[k]]) continue; qi.addVideoEffect(qe.project.getVideoEffectByName(W[k])); has[W[k]]=(has[W[k]]||0)+1; added++; }
        return JSON.stringify({added:added});`);
      console.log(`fx ${x.id.slice(-2)} ${x.name}: added ${r.added} (${want.join(', ')})`);
    }
  },
  async props() {
    const snap = JSON.parse(readFileSync(SNAP, 'utf8'));
    for (const x of snap.rows.filter((y) => y.covered && !SKIP.has(y.id))) {
      // a render Resolve rotated by a source's rotation flag needs no turn of its own: Premiere honours the flag too
      // (the edit's own Motion, e.g. Rotation 90, already undid it) and shows the render as it showed the source
      const r = await run(`p.openSequence(S.sequenceID); var T=S.videoTracks[${x.tr}], n=at(T, ${x.a}, ${JSON.stringify(x.render)}); if(!n) return JSON.stringify({error:'no render item'});
        var C=${JSON.stringify(x.comps)}, shift=n.inPoint.seconds-${x.ins}, mine={}, seen={}, occ={}, nset=0, keyed=0, note=[];
        function same(a,b){ if(a===null||b===null||a===undefined||b===undefined) return a===b; if(typeof a==='object' && a.length!==undefined){ if(b.length!==a.length) return false; for(var z=0;z<a.length;z++) if(!same(a[z],b[z])) return false; return true; } if(typeof a==='number' && typeof b==='number') return Math.abs(a-b)<1e-6; return String(a)===String(b); }
        for(k=0;k<n.components.numItems;k++){ var d=String(n.components[k].displayName); seen[d]=(seen[d]||0)+1; mine[d+'#'+seen[d]]=n.components[k]; }
        for(k=0;k<C.length;k++){ var w=C[k]; occ[w.dn]=(occ[w.dn]||0)+1; var mc=mine[w.dn+'#'+occ[w.dn]]; if(!mc){ note.push('no '+w.dn); continue; }
          for(j=0;j<w.p.length && j<mc.properties.numItems;j++){ var src=w.p[j], P=mc.properties[j]; if(src.err || String(P.displayName)!==src.n) continue;
            try{ if(src.keys){ if(P.isTimeVarying()) P.setTimeVarying(false); P.setTimeVarying(true);
                for(q=0;q<src.keys.length;q++){ var tt=src.keys[q][0]+shift; P.addKey(tt); P.setValueAtKey(tt, src.keys[q][1], true); } keyed++; }
              else if(src.v!==undefined){ var cur=P.isTimeVarying()?null:P.getValue();
                // a 64-bit colour (Lumetri's selector swatches, 0xFF00000000000000) does not survive a double: leave it
                if(typeof src.v==='number' && Math.abs(src.v)>9007199254740991) continue;
                if(!same(cur, src.v)){ if(P.isTimeVarying()) P.setTimeVarying(false); P.setValue(src.v, true); nset++; } } }catch(e3){ note.push(w.dn+' › '+src.n+': '+String(e3)); } } }
        return JSON.stringify({nset:nset, keyed:keyed, note:note});`);
      if (r.nset || r.keyed || r.note.length) console.log(`props ${x.id.slice(-2)} ${x.name}: ${r.nset} values, ${r.keyed} keyed${r.note.length ? ' ' + r.note.join('; ') : ''}`);
    }
    console.log('props: done');
  },
  async trans() {
    const snap = JSON.parse(readFileSync(SNAP, 'utf8')), FD = Number(BigInt(snap.fdT)) / Number(TPS), fps = Math.round(1 / FD);
    const now = await run(`var o=[]; for(t=0;t<S.videoTracks.numTracks;t++){ var T=S.videoTracks[t]; for(k=0;k<T.transitions.numItems;k++){ var x=T.transitions[k]; o.push([t, R(x.start.seconds), R(x.end.seconds)]); } } return JSON.stringify(o);`, { mutating: false });
    const tc = (sec) => { const f = Math.round(sec / FD); const p2 = (v) => String(v).padStart(2, '0'); return `${p2(Math.floor(f / (fps * 3600)))}:${p2(Math.floor(f / (fps * 60)) % 60)}:${p2(Math.floor(f / fps) % 60)}:${p2(f % fps)}`; };
    for (const t of snap.trans) {
      if (now.some(([tr, s, e]) => tr === t.tr && Math.abs(s - t.s) < 0.01 && Math.abs(e - t.e) < 0.01)) continue;
      const r = await run(`p.openSequence(S.sequenceID); var T=S.videoTracks[${t.tr}], hd=null, tl=null, prev=false, next=false;
        for(k=0;k<T.clips.numItems;k++){ var c=T.clips[k];
          if(Math.abs(c.start.seconds-${t.e})<0.01 || Math.abs(c.start.seconds-${t.s})<0.01) hd=c;
          if(Math.abs(c.end.seconds-${t.e})<0.01 || Math.abs(c.end.seconds-${t.s})<0.01) tl=c; }
        var host, atStart, align, cut;
        if(hd && Math.abs(hd.start.seconds-${t.e})<0.01){ host=hd; atStart=true; align=1; cut=${t.e}; }
        else if(hd){ host=hd; atStart=true; align=0; cut=${t.s}; }
        else if(tl && Math.abs(tl.end.seconds-${t.e})<0.01){ host=tl; atStart=false; align=1; cut=${t.e}; }
        else if(tl){ host=tl; atStart=false; align=0; cut=${t.s}; }
        else return JSON.stringify({error:'no clip edge at the transition ${t.s}-${t.e}'});
        var other=false; for(k=0;k<T.clips.numItems;k++){ var c2=T.clips[k]; if(c2!==host && (Math.abs(c2.end.seconds-cut)<0.01 || Math.abs(c2.start.seconds-cut)<0.01)) other=true; }
        var qi=qeAt(${t.tr}, host.start.seconds); if(!qi) return JSON.stringify({error:'no QE item'});
        var ok=qi.addTransition(qe.project.getVideoTransitionByName(${JSON.stringify(t.name)}), atStart, ${JSON.stringify(tc(t.e - t.s))}, '00:00:00:00', align, !other, true);
        var got=[]; for(k=0;k<T.transitions.numItems;k++){ var x=T.transitions[k]; got.push([R(x.start.seconds), R(x.end.seconds)]); }
        return JSON.stringify({ok:String(ok), host:String(host.name).slice(-18), atStart:atStart, align:align, single:!other, got:got});`);
      const placed = r.got.some(([s, e]) => Math.abs(s - t.s) < 0.01 && Math.abs(e - t.e) < 0.01);
      console.log(`trans V${t.tr + 1} ${t.s}-${t.e} ${t.name} on ${r.host} (${r.atStart ? 'head' : 'tail'}, alignment ${r.align}${r.single ? ', single-sided' : ''}): ${placed ? 'back in place' : 'NOT where it was ' + JSON.stringify(r.got)}`);
      if (!placed) throw new Error('transition not restored');
    }
    console.log('trans: done');
  },
  async check() {
    const snap = JSON.parse(readFileSync(SNAP, 'utf8')), before = JSON.parse(readFileSync(DUMP0, 'utf8')).seqs.find((x) => x.name === SEQ), after = dump(DUMP1);
    const rows = Object.fromEntries(snap.rows.filter((y) => y.covered && !SKIP.has(y.id)).map((y) => [`${y.tr}|${Math.round(y.a * 100)}`, y]));
    const key = (c) => `${c[0]}|${c[1]}|${c[2]}|${c[3]}`, errs = [];
    before.v.forEach((L, ti) => {
      const N = after.v[ti] || [];
      if (N.length !== L.length) { errs.push(`V${ti + 1}: ${N.length} items, ${L.length} before`); return; }
      L.forEach((o, k) => { const g = N[k], w = rows[`${ti}|${Math.round(o[1] * 100)}`];
        if (w) { if (g[0] !== w.render || Math.abs(g[1] - w.a) > 0.005 || Math.abs(g[2] - w.b) > 0.005) errs.push(`${w.id}: want ${w.render} ${w.a}-${w.b}, got ${g.slice(0, 3).join(' ')}`); }
        else if (key(o) !== key(g)) errs.push(`V${ti + 1} ${o[1]}: ${key(o)} -> ${key(g)}`); });
    });
    before.a.forEach((L, ti) => { if (JSON.stringify(L.map(key)) !== JSON.stringify((after.a[ti] || []).map(key))) errs.push(`A${ti + 1} changed`); });
    if (JSON.stringify(before.vt) !== JSON.stringify(after.vt)) errs.push(`transitions ${JSON.stringify(before.vt)} -> ${JSON.stringify(after.vt)}`);
    if (JSON.stringify(before.markers) !== JSON.stringify(after.markers)) errs.push('markers changed');
    if (before.end !== after.end) errs.push(`end ${before.end} -> ${after.end}`);
    const vals = await run(`var P=${JSON.stringify(Object.values(rows).map((y) => ({ id: y.id, tr: y.tr, a: y.a, render: y.render })))}, o=[];
      for(k=0;k<P.length;k++){ var c=at(S.videoTracks[P[k].tr], P[k].a, P[k].render); if(!c){ o.push({id:P[k].id}); continue; } var sp=1, rv=false; try{ sp=c.getSpeed(); rv=c.isSpeedReversed(); }catch(e){}
        o.push({id:P[k].id, inT:String(c.inPoint.ticks), sp:sp, rev:rv?1:0, comps:comps(c)}); } return JSON.stringify(o);`, { mutating: false });
    for (const v of vals) {
      const w = snap.rows.find((y) => y.id === v.id);
      if (!v.comps) { errs.push(`${v.id}: render item not found`); continue; }
      if (Math.abs(Number(BigInt(v.inT) - BigInt(w.inNT))) > 1e4) errs.push(`${v.id}: in ${v.inT} != ${w.inNT}`);
      if (Math.abs(v.sp - Number(w.spN) / Number(w.spD)) > 1e-4 || v.rev !== w.rev) errs.push(`${v.id}: speed ${v.sp} rev ${v.rev}`);
      const occ = {}, mine = {}, seen = {};
      for (const c of v.comps) { seen[c.dn] = (seen[c.dn] || 0) + 1; mine[`${c.dn}#${seen[c.dn]}`] = c; }
      for (const c of w.comps) {
        occ[c.dn] = (occ[c.dn] || 0) + 1; const m = mine[`${c.dn}#${occ[c.dn]}`];
        if (!m) { errs.push(`${v.id}: ${c.dn} missing`); continue; }
        c.p.forEach((q, j) => { const g = m.p[j]; if (q.err || !g || g.n !== q.n) return;
          if (q.keys) { if (!g.keys || g.keys.length !== q.keys.length) errs.push(`${v.id}: ${c.dn} › ${q.n} keys`); return; }
          if (typeof q.v === 'number' && Math.abs(q.v) > 9007199254740991) return;   // 64-bit swatches: not settable from a script
          const eq = (x, y) => Array.isArray(x) ? Array.isArray(y) && x.length === y.length && x.every((u, z) => eq(u, y[z])) : (typeof x === 'number' && typeof y === 'number' ? Math.abs(x - y) < 1e-4 : String(x) === String(y));
          if (!eq(q.v, g.v)) errs.push(`${v.id}: ${c.dn} › ${q.n} ${JSON.stringify(q.v)} -> ${JSON.stringify(g.v)}`); });
      }
    }
    console.log(`check ${SEQ}: ${Object.keys(rows).length} renders; ${errs.length ? 'MISMATCH\n  ' + errs.slice(0, 12).join('\n  ') : 'every render at its place with its in/out, speed, reverse, Motion and effects; every other item, the audio, the transitions, the markers and the end as before'}`);
    if (errs.length) process.exit(1);
  },
};
await steps[STEP]();
