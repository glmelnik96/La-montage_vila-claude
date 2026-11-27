// Put graded renders from DaVinci back into the episodes.
//   node scripts/gradesub.mjs --expect <path part> --plan <plan.json> --xml <grading xml>
//        --renders <dir> --bin "<bin>" --tag "<backup suffix>" [--name-re <regex>] [--single <file>]
//        --step match|backup|snapshot|import|place|fx|props|check|all
// match     each render file to a plan row by source name + source timecode in frames (the XML's file
//           timecode + the row's in-point), both read from the file name by --name-re (default
//           «<source>true<TC in frames>.<ext>», as the user's Resolve preset writes them); frame
//           count, size and rate probed. Run scripts/gridfix.mjs on the episodes BEFORE place.
//           --single <file>: ONE render of the whole grading timeline instead (the user rendered it so on
//           2026-10-27). Its frame count must be the timeline's, every row takes its own range of it (in =
//           the row's grading start), and the gaps between packed rows must be black in it, the rows not.
// snapshot  the episodes as they are before the substitution (for check), and every component of each
//           item to be replaced, keys included (for props). Refuses once the items are replaced.
// place     per row, Sequence.overwriteClip at the row's start on the row's own track (V1, or the one a
//           gradexml.mjs --tracks plan names): the graded clip covers exactly its fragment, the camera
//           audio on A1 is not targeted (a render with audio of its own lands on the last audio track and
//           is removed there)
// fx        the old item's video effects (a Crop) added to the new one through QE
// props     the old item's Motion, Opacity and effect values set on the new one, keys moved with the
//           in-point. An edit in a smaller frame scales and crops every piece its own way.
// check     the rows' ranges hold the renders at the right in-points with the snapshot's values; every
//           other item, every audio track, the markers and in/out as before
// Made for plans of mode "all": every fragment is a whole item.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { callBridge } from './lib/prbridge.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const EXPECT = arg('expect'), PLAN = arg('plan'), XMLP = arg('xml'), DIR = arg('renders'), BIN = arg('bin'), TAG = arg('tag'), STEP = arg('step');
const SINGLE = arg('single');
const NAME_RE = new RegExp(arg('name-re', '^(.*?)true(\\d+)\\.[^.]+$'));
if (!EXPECT || !PLAN || !XMLP || !DIR || !BIN || !TAG || !STEP) { console.error('missing args'); process.exit(2); }
const FPS = 25;
const fwd = (p) => p.replace(/\\/g, '/').replace(/\/$/, '');
const RDIR = fwd(DIR);
const MAP = PLAN.replace(/\.json$/, '') + ' — рендеры.json';
const SNAP = PLAN.replace(/\.json$/, '') + ' — до подстановки.json';
const PROPS = PLAN.replace(/\.json$/, '') + ' — свойства.json';
const plan = JSON.parse(readFileSync(PLAN, 'utf8'));
if (plan.mode !== 'all') { console.error('this substitution handles plans of mode "all" only'); process.exit(2); }
const EPS = [...new Set(plan.rows.map((r) => r.ep))];
const base = (n) => n.replace(/\.[^.]+$/, '');
const INTRINSIC = ['Opacity', 'Motion', 'Time Remapping'];

function tcStarts() {
  const x = readFileSync(XMLP, 'utf8'), out = {};
  for (const m of x.matchAll(/<file id="[^"]+">([\s\S]*?)<\/file>/g)) {
    const body = m[1], name = (body.match(/<name>([^<]+)<\/name>/) || [])[1];
    const tc = (body.match(/<timecode>[\s\S]*?<string>([^<]+)<\/string>/) || [])[1];
    if (name && tc) { const [h, mi, s, f] = tc.split(/[:;]/).map(Number); out[base(name)] = ((h * 60 + mi) * 60 + s) * FPS + f; }
  }
  return out;
}
function probe(p) {
  const j = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-count_packets', '-show_entries',
    'stream=codec_type,codec_name,width,height,r_frame_rate,nb_read_packets,pix_fmt,bit_rate', '-of', 'json', p], { encoding: 'utf8' }));
  const v = j.streams.find((s) => s.codec_type === 'video');
  const [n, d] = v.r_frame_rate.split('/').map(Number);
  return { codec: v.codec_name, w: v.width, h: v.height, fps: n / d, frames: +v.nb_read_packets, pix: v.pix_fmt,
    mbps: v.bit_rate ? Math.round(v.bit_rate / 1e6) : null, audio: j.streams.some((s) => s.codec_type === 'audio') };
}
// per frame of a render: is it black (mean and spread of a 64x36 grey copy)
function blackFrames(p) {
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-threads', '0', '-i', p, '-map', '0:v:0', '-vf', 'scale=64:36:flags=area,format=gray',
    '-f', 'rawvideo', '-'], { maxBuffer: 1 << 30 });
  const n = 64 * 36, out = [];
  for (let k = 0; k + n <= raw.length; k += n) {
    let s = 0, s2 = 0;
    for (let i = k; i < k + n; i++) { s += raw[i]; s2 += raw[i] * raw[i]; }
    const m = s / n; out.push(m < 20 && Math.sqrt(Math.max(0, s2 / n - m * m)) < 3);
  }
  return out;
}
function dump(out) {
  execFileSync('node', [fileURLToPath(new URL('./seqdump.mjs', import.meta.url)), '--out', out, '--seqs', EPS.join(',')], { encoding: 'utf8' });
  const d = JSON.parse(readFileSync(out, 'utf8'));
  if (!d.project.includes(EXPECT)) throw new Error('dump of the wrong project: ' + d.project);
  return d;
}

const HEAD = `var p=app.project, i, t, q, k;
  if(String(p.path).indexOf(${JSON.stringify(EXPECT)})<0) return JSON.stringify({error:'focused project is '+p.path});
  function seqNamed(nm){ for(var j=0;j<p.sequences.numSequences;j++){ if(String(p.sequences[j].name)===nm) return p.sequences[j]; } return null; }
  function binNamed(nm){ for(var j=0;j<p.rootItem.children.numItems;j++){ var b=p.rootItem.children[j]; if(b.type===2 && String(b.name)===nm) return b; } return null; }
  function fw(s){ return String(s).split(String.fromCharCode(92)).join('/'); }
  function R(x){ return Math.round(x*1000)/1000; }
  function at(tr,t0,nm){ for(var j=0;j<tr.clips.numItems;j++){ var c=tr.clips[j]; if(Math.abs(c.start.seconds-t0)<0.02 && (!nm || String(c.name)===nm)) return c; } return null; }
  function comps(c){ var o=[], j, kk, qq; for(j=0;j<c.components.numItems;j++){ var m=c.components[j], pr=[];
      for(kk=0;kk<m.properties.numItems;kk++){ var P=m.properties[kk], e={n:String(P.displayName)};
        try{ if(P.isTimeVarying()){ var ks=P.getKeys(), kv=[]; for(qq=0;qq<ks.length;qq++) kv.push([ks[qq].seconds, P.getValueAtKey(ks[qq])]); e.keys=kv; } else e.v=P.getValue(); }catch(x){ e.err=1; }
        pr.push(e); }
      o.push({dn:String(m.displayName), mn:String(m.matchName), p:pr}); }
    return o; }`;
async function run(body, opts = {}) {
  const raw = await callBridge('evalJson', [`(function(){ try { ${HEAD} ${body} } catch(e){ return JSON.stringify({error:String(e), line:e.line}); } })()`], { timeoutMs: 110000, ...opts });
  const r = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (r && r.error) throw new Error(JSON.stringify(r));
  return r;
}
const backupName = (s) => `_OLD_${s} (${TAG})`;
const rowsOf = (m, ep) => m.rows.filter((r) => r.ep === ep).sort((a, b) => (a.tr || 0) - (b.tr || 0) || a.a - b.a)
  .map((x) => ({ id: x.id, render: x.render, a: x.a, b: x.b, tr: x.tr || 0, rin: x.rin || 0, single: !!SINGLE }));
// a component's values against another's: numbers to 1e-4, arrays element by element, keys too
function sameVal(x, y) {
  if (Array.isArray(x) || Array.isArray(y)) return Array.isArray(x) && Array.isArray(y) && x.length === y.length && x.every((v, i) => sameVal(v, y[i]));
  if (typeof x === 'number' && typeof y === 'number') return Math.abs(x - y) < 1e-4;
  return String(x) === String(y);
}

const steps = {
  async match() {
    const used = new Set(), rows = [], errs = [];
    let extra = [];
    if (SINGLE) {
      const pr = probe(`${RDIR}/${SINGLE}`), total = Math.round(Math.max(...plan.rows.map((r) => r.ge)) * FPS);
      if (pr.frames !== total) errs.push(`${SINGLE}: ${pr.frames} frames, the grading timeline has ${total}`);
      if (pr.w !== 3840 || pr.h !== 2160 || Math.abs(pr.fps - FPS) > 1e-6) errs.push(`${SINGLE}: ${pr.w}x${pr.h} @${pr.fps}`);
      const want = new Array(total).fill(false);
      for (const r of plan.rows) for (let f = Math.round(r.gs * FPS); f < Math.round(r.ge * FPS); f++) want[f] = true;
      if (want.some((w) => !w)) {
        const bl = blackFrames(`${RDIR}/${SINGLE}`);
        const pic = bl.map((b, f) => !b && !want[f] ? f : -1).filter((f) => f >= 0), dark = bl.map((b, f) => b && want[f] ? f : -1).filter((f) => f >= 0);
        console.log(`gaps: ${want.filter((w) => !w).length} frames planned, ${bl.filter(Boolean).length} black in the render; picture in a gap: ${pic.length}, black inside a row: ${dark.length}`);
        if (pic.length) errs.push(`picture in the gaps at frames ${pic.slice(0, 8).join(', ')}: the render is not in step with the plan`);
        if (dark.length) console.log(`  black frames inside rows (look at them): ${dark.slice(0, 12).join(', ')}`);
      }
      for (const r of plan.rows) rows.push({ ...r, render: SINGLE, rin: r.gs, frames: Math.round((r.ge - r.gs) * FPS), probe: pr });
    } else {
      const tc = tcStarts();
      const parsed = readdirSync(DIR).filter((f) => /\.(mp4|mov|mxf)$/i.test(f))
        .map((f) => { const m = f.match(NAME_RE); return m ? { f, src: m[1], tc: +m[2] } : { f, src: null }; });
      for (const r of plan.rows) {
        const want = tc[base(r.name)] + Math.round(r.sIn * FPS), n = Math.round((r.ge - r.gs) * FPS);
        const hit = parsed.filter((x) => x.src === base(r.name) && x.tc === want);
        if (hit.length !== 1) { errs.push(`${r.id} ${r.name} tc ${want}: ${hit.length} renders`); continue; }
        const pr = probe(`${RDIR}/${hit[0].f}`);
        used.add(hit[0].f);
        if (pr.frames !== n) errs.push(`${r.id} ${hit[0].f}: ${pr.frames} frames, plan ${n}`);
        if (pr.w !== 3840 || pr.h !== 2160 || Math.abs(pr.fps - FPS) > 1e-6) errs.push(`${r.id} ${hit[0].f}: ${pr.w}x${pr.h} @${pr.fps}`);
        rows.push({ ...r, render: hit[0].f, rin: 0, frames: pr.frames, probe: pr });
      }
      extra = parsed.filter((x) => !used.has(x.f)).map((x) => x.f);
    }
    writeFileSync(MAP, JSON.stringify({ renders: RDIR, single: SINGLE || null, rows }, null, 1));
    const P = rows[0]?.probe || {};
    console.log(`match: ${rows.length}/${plan.rows.length} fragments have a render; ${extra.length} renders unused${extra.length ? ': ' + extra.join(', ') : ''}`);
    console.log(`renders: ${P.codec} ${P.pix} ${P.w}x${P.h} @${P.fps} ~${P.mbps} Mbit/s; audio: ${rows.some((r) => r.probe.audio) ? 'YES' : 'none'}`);
    if (errs.length) { console.log('PROBLEMS:\n  ' + errs.join('\n  ')); process.exit(1); }
    console.log('every render is its fragment, frame for frame -> ' + MAP);
  },
  async backup() {
    for (const s of EPS) {
      const r = await run(`var S=seqNamed(${JSON.stringify(s)}), K=seqNamed(${JSON.stringify(backupName(s))});
        if(!S) return JSON.stringify({error:'no sequence'}); if(K) return JSON.stringify({kept:String(K.name)});
        var before={}; for(i=0;i<p.sequences.numSequences;i++) before[String(p.sequences[i].sequenceID)]=1;
        S.clone(); var made=null; for(i=0;i<p.sequences.numSequences;i++){ if(!before[String(p.sequences[i].sequenceID)]) made=p.sequences[i]; }
        if(!made) return JSON.stringify({error:'clone not found'}); made.name=${JSON.stringify(backupName(s))};
        return JSON.stringify({made:String(made.name)});`);
      console.log('backup', s, JSON.stringify(r));
    }
  },
  async snapshot() {
    // the components first: it fails, and writes nothing, once the items are already replaced
    const out = [];
    for (const ep of EPS) {
      const rows = plan.rows.filter((r) => r.ep === ep).map((r) => ({ id: r.id, tr: r.tr || 0, a: r.a, name: r.name }));
      for (let i = 0; i < rows.length; i += 10) {
        const r = await run(`var S=seqNamed(${JSON.stringify(ep)}), P=${JSON.stringify(rows.slice(i, i + 10))}, o=[], bad=[];
          for(k=0;k<P.length;k++){ var c=at(S.videoTracks[P[k].tr], P[k].a, P[k].name); if(!c){ bad.push(P[k].id); continue; }
            o.push({id:P[k].id, start:c.start.seconds, ip:c.inPoint.seconds, comps:comps(c)}); }
          return JSON.stringify({o:o, bad:bad});`, { mutating: false });
        if (r.bad.length) throw new Error(`no original item for ${r.bad.join(', ')}: already replaced? the snapshot is kept as it was`);
        out.push(...r.o);
      }
    }
    writeFileSync(PROPS, JSON.stringify(out, null, 1));
    const d = dump(SNAP);
    console.log(`snapshot: ${d.seqs.filter((x) => x.v).length} episodes -> ${SNAP}; ${out.length} items' components -> ${PROPS}`);
  },
  async import() {
    const m = JSON.parse(readFileSync(MAP, 'utf8'));
    const paths = [...new Set(m.rows.map((r) => `${RDIR}/${r.render}`))];
    const r = await run(`var b=binNamed(${JSON.stringify(BIN)});
      if(!b){ p.rootItem.createBin(${JSON.stringify(BIN)}); b=binNamed(${JSON.stringify(BIN)}); }
      var F=${JSON.stringify(paths)}, have={}, todo=[];
      for(i=0;i<b.children.numItems;i++) have[fw(b.children[i].getMediaPath())]=1;
      for(i=0;i<F.length;i++){ if(!have[fw(new File(F[i]).fsName)]) todo.push(new File(F[i]).fsName); }
      if(todo.length) p.importFiles(todo, true, b, false);
      var n=b.children.numItems, bad=[]; for(i=0;i<n;i++){ if(fw(b.children[i].getMediaPath()).indexOf(${JSON.stringify(RDIR)})!==0) bad.push(String(b.children[i].name)); }
      return JSON.stringify({bin:String(b.name), n:n, imported:todo.length, bad:bad});`);
    console.log('import', JSON.stringify(r));
    if (r.n !== paths.length || r.bad.length) throw new Error(`bin holds ${r.n} of ${paths.length}`);
  },
  async place() {
    const m = JSON.parse(readFileSync(MAP, 'utf8'));
    for (const ep of EPS) {
      const rows = rowsOf(m, ep);
      for (let pass = 1; pass <= 60; pass++) {
        const r = await run(`var S=seqNamed(${JSON.stringify(ep)}); if(!S) return JSON.stringify({error:'no sequence'});
          p.openSequence(S.sequenceID); var s=p.activeSequence; if(String(s.sequenceID)!==String(S.sequenceID)) return JSON.stringify({error:'not active'});
          var b=binNamed(${JSON.stringify(BIN)}), items={}; for(i=0;i<b.children.numItems;i++) items[String(b.children[i].name)]=b.children[i];
          var P=${JSON.stringify(rows)}, AT=s.audioTracks.numTracks-1, TPF=Number(s.getSettings().videoFrameRate.ticks), n=0, rem=0, note=[];
          function tk(x){ var o=new Time(); o.ticks=String(Math.round(x*254016000000/TPF)*TPF); return o; }
          if(s.audioTracks[AT].clips.numItems>0) return JSON.stringify({error:'the last audio track is not empty'});
          for(k=0;k<P.length;k++){ var e=P[k], V=s.videoTracks[e.tr], d=e.b-e.a;
            var have=at(V,e.a,e.render); if(have && Math.abs(have.end.seconds-e.b)<0.02 && Math.abs(have.inPoint.seconds-e.rin)<0.02) continue;
            if(n>=6){ rem++; continue; }
            var pi=items[e.render]; if(!pi){ note.push(e.id+': not in bin'); n++; continue; }
            if(e.single){ pi.setInPoint(e.rin+0.001,4); pi.setOutPoint(e.rin+d+0.001,4); }
            s.overwriteClip(pi, e.a+0.001, e.tr, AT);
            if(e.single){ try{ pi.clearInPoint(); pi.clearOutPoint(); }catch(e1){} }
            var v=at(V,e.a,e.render);
            if(!v){ note.push(e.id+' not placed'); n++; continue; }
            if(Math.abs(v.end.seconds-e.b)>=0.02){ v.outPoint=tk(e.rin+d); v.end=tk(e.b); }
            if(Math.abs(v.end.seconds-e.b)>=0.02) note.push(e.id+': end '+R(v.end.seconds)+' != '+e.b);
            if(Math.abs(v.inPoint.seconds-e.rin)>=0.02) note.push(e.id+': in '+R(v.inPoint.seconds)+' != '+e.rin);
            var ga=at(s.audioTracks[AT],e.a,e.render); if(ga) ga.remove(0,0);
            n++; }
          return JSON.stringify({done:n, remaining:rem, note:note, leftOnLastAudio:s.audioTracks[AT].clips.numItems});`);
        console.error(`  ${ep} pass ${pass}: placed ${r.done}, remaining ${r.remaining}${r.note.length ? ' NOTES ' + r.note.join('; ') : ''}${r.leftOnLastAudio ? ' AUDIO LEFT ' + r.leftOnLastAudio : ''}`);
        if (r.note.length || r.leftOnLastAudio) throw new Error('placement problem');
        if (r.remaining === 0) break;
      }
    }
  },
  async fx() {
    // QE serves a stale item list: one window of rows per call, and the DOM decides what is missing
    const m = JSON.parse(readFileSync(MAP, 'utf8')), PR = Object.fromEntries(JSON.parse(readFileSync(PROPS, 'utf8')).map((x) => [x.id, x]));
    for (const ep of EPS) {
      const rows = rowsOf(m, ep).map((r) => ({ ...r, fx: PR[r.id].comps.map((c) => c.dn).filter((n) => !INTRINSIC.includes(n)) })).filter((r) => r.fx.length);
      for (let i = 0; i < rows.length; i += 6) {
        const r = await run(`var S=seqNamed(${JSON.stringify(ep)}); p.openSequence(S.sequenceID); var s=p.activeSequence;
          app.enableQE(); var Q=qe.project.getActiveSequence(), P=${JSON.stringify(rows.slice(i, i + 6))}, added=0, note=[];
          for(k=0;k<P.length;k++){ var e=P[k], c=at(s.videoTracks[e.tr], e.a, e.render); if(!c){ note.push(e.id+' missing'); continue; }
            var has={}, want={}, j; for(j=0;j<c.components.numItems;j++){ var dn=String(c.components[j].displayName); has[dn]=(has[dn]||0)+1; }
            for(j=0;j<e.fx.length;j++){ want[e.fx[j]]=(want[e.fx[j]]||0)+1;
              if((has[e.fx[j]]||0)>=want[e.fx[j]]) continue;
              var qt=Q.getVideoTrackAt(e.tr), qi=null; for(q=0;q<qt.numItems;q++){ var it=qt.getItemAt(q); if(String(it.type)==='Clip' && Math.abs(parseFloat(it.start.secs)-e.a)<0.02) qi=it; }
              var ef=qe.project.getVideoEffectByName(e.fx[j]); if(!qi||!ef){ note.push(e.id+': '+(qi?'no effect '+e.fx[j]:'no QE item')); continue; }
              qi.addVideoEffect(ef); has[e.fx[j]]=(has[e.fx[j]]||0)+1; added++; } }
          return JSON.stringify({added:added, note:note});`);
        console.log(`fx ${ep} rows ${i + 1}-${Math.min(i + 6, rows.length)}: added ${r.added}${r.note.length ? ' NOTES ' + r.note.join('; ') : ''}`);
        if (r.note.length) throw new Error('fx problem');
      }
    }
  },
  async props() {
    const m = JSON.parse(readFileSync(MAP, 'utf8')), PR = Object.fromEntries(JSON.parse(readFileSync(PROPS, 'utf8')).map((x) => [x.id, x]));
    for (const ep of EPS) {
      const rows = rowsOf(m, ep);
      for (let i = 0; i < rows.length; i += 6) {
        const part = rows.slice(i, i + 6).map((r) => ({ ...r, ip0: PR[r.id].ip, comps: PR[r.id].comps }));
        const r = await run(`var S=seqNamed(${JSON.stringify(ep)}); p.openSequence(S.sequenceID); var s=p.activeSequence;
          var P=${JSON.stringify(part)}, nset=0, keyed=0, note=[];
          for(k=0;k<P.length;k++){ var e=P[k], c=at(s.videoTracks[e.tr], e.a, e.render); if(!c){ note.push(e.id+' missing'); continue; }
            var mine={}, seen={}, j, jj, kq; for(j=0;j<c.components.numItems;j++){ var dn=String(c.components[j].displayName); seen[dn]=(seen[dn]||0)+1; mine[dn+'#'+seen[dn]]=c.components[j]; }
            var occ={}; for(j=0;j<e.comps.length;j++){ var w=e.comps[j]; occ[w.dn]=(occ[w.dn]||0)+1; var mc=mine[w.dn+'#'+occ[w.dn]];
              if(!mc){ note.push(e.id+': no '+w.dn); continue; }
              for(jj=0;jj<w.p.length && jj<mc.properties.numItems;jj++){ var src=w.p[jj], P2=mc.properties[jj];
                if(src.err || String(P2.displayName)!==src.n) continue;
                try{ if(src.keys){ if(P2.isTimeVarying()) P2.setTimeVarying(false); P2.setTimeVarying(true);
                    for(kq=0;kq<src.keys.length;kq++){ var tt=src.keys[kq][0]-e.ip0+c.inPoint.seconds; P2.addKey(tt); P2.setValueAtKey(tt, src.keys[kq][1], true); } keyed++; }
                  else if(src.v!==undefined){ if(P2.isTimeVarying()) P2.setTimeVarying(false); P2.setValue(src.v, true); nset++; } }catch(x){ note.push(e.id+': '+w.dn+' › '+src.n+' '+String(x)); } } } }
          return JSON.stringify({nset:nset, keyed:keyed, note:note});`);
        console.log(`props ${ep} rows ${i + 1}-${Math.min(i + 6, rows.length)}: ${r.nset} values, ${r.keyed} keyed${r.note.length ? ' NOTES ' + r.note.slice(0, 6).join('; ') : ''}`);
      }
    }
  },
  async check() {
    const m = JSON.parse(readFileSync(MAP, 'utf8')), before = JSON.parse(readFileSync(SNAP, 'utf8')), PR = JSON.parse(readFileSync(PROPS, 'utf8'));
    const now = dump(PLAN.replace(/\.json$/, '') + ' — после подстановки.json');
    const key = (c) => `${c[0]}|${c[1]}|${c[2]}|${c[3]}`;
    let bad = 0;
    for (const ep of EPS) {
      const a = before.seqs.find((x) => x.name === ep), b = now.seqs.find((x) => x.name === ep), errs = [];
      const rows = rowsOf(m, ep), byPlace = Object.fromEntries(rows.map((r) => [`${r.tr}|${Math.round(r.a * FPS)}`, r]));
      a.v.forEach((L, ti) => {
        const N = b.v[ti] || [];
        if (N.length !== L.length) { errs.push(`V${ti + 1}: ${N.length} items, ${L.length} before`); return; }
        L.forEach((o, k) => {
          const g = N[k], w = byPlace[`${ti}|${Math.round(o[1] * FPS)}`];
          if (w) { if (g[0] !== w.render || Math.abs(g[1] - w.a) > 0.011 || Math.abs(g[2] - w.b) > 0.011 || Math.abs(g[3] - w.rin) > 0.011 || !fwd(g[5]).startsWith(RDIR))
            errs.push(`${w.id}: want ${w.render} ${w.a}-${w.b} in ${w.rin}, got ${g.slice(0, 4).join(' ')}`); }
          else if (key(o) !== key(g)) errs.push(`V${ti + 1} ${o[1]}: ${key(o)} -> ${key(g)}`);
        });
      });
      a.a.forEach((L, ti) => { if (JSON.stringify(L.map(key)) !== JSON.stringify((b.a[ti] || []).map(key))) errs.push(`A${ti + 1} changed`); });
      if (JSON.stringify(a.markers) !== JSON.stringify(b.markers)) errs.push('markers changed');
      if (a.end !== b.end || a.inP !== b.inP || a.outP !== b.outP) errs.push(`end/in/out ${a.end}/${a.outP} -> ${b.end}/${b.outP}`);
      // the values: every component of the old item, on the new one (key times moved with the in-point)
      for (let i = 0; i < rows.length; i += 10) {
        const part = rows.slice(i, i + 10);
        const r = await run(`var S=seqNamed(${JSON.stringify(ep)}), P=${JSON.stringify(part)}, o=[];
          for(k=0;k<P.length;k++){ var c=at(S.videoTracks[P[k].tr], P[k].a, P[k].render); o.push(c?{id:P[k].id, ip:c.inPoint.seconds, comps:comps(c)}:{id:P[k].id}); }
          return JSON.stringify(o);`, { mutating: false });
        for (const x of r) {
          const old = PR.find((y) => y.id === x.id);
          if (!x.comps) { errs.push(`${x.id}: not found`); continue; }
          const occ = {}, have = {}, seen = {};
          for (const c of x.comps) { seen[c.dn] = (seen[c.dn] || 0) + 1; have[`${c.dn}#${seen[c.dn]}`] = c; }
          for (const c of old.comps) {
            occ[c.dn] = (occ[c.dn] || 0) + 1; const n = have[`${c.dn}#${occ[c.dn]}`];
            if (!n) { errs.push(`${x.id}: ${c.dn} missing`); continue; }
            c.p.forEach((q, j) => {
              const g = n.p[j]; if (q.err || !g || g.n !== q.n) return;
              if (q.keys) { if (!g.keys || g.keys.length !== q.keys.length || !q.keys.every((kk, z) => Math.abs(kk[0] - old.ip + x.ip - g.keys[z][0]) < 0.002 && sameVal(kk[1], g.keys[z][1]))) errs.push(`${x.id}: ${c.dn} › ${q.n} keys differ`); }
              else if (q.v !== undefined && !sameVal(q.v, g.v)) errs.push(`${x.id}: ${c.dn} › ${q.n} ${JSON.stringify(q.v)} -> ${JSON.stringify(g.v)}`);
            });
          }
        }
      }
      console.log(`check ${ep}: ${rows.length} fragments; ${errs.length ? 'MISMATCH ' + errs.slice(0, 8).join(' ; ') : 'every fragment is its graded range at its place, with its own Motion and effects; everything else, audio, markers and in/out as before'}`);
      bad += errs.length;
    }
    if (bad) process.exit(1);
  },
};
const order = STEP === 'all' ? ['match', 'backup', 'snapshot', 'import', 'place', 'fx', 'props', 'check'] : [STEP];
for (const st of order) await steps[st]();
