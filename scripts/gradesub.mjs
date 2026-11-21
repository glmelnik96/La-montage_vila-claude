// Put graded renders from DaVinci back over V1 of the episodes.
//   node scripts/gradesub.mjs --expect <path part> --plan <plan.json> --xml <grading xml>
//        --renders <dir> --bin "<bin>" --tag "<backup suffix>" [--name-re <regex>]
//        --step match|backup|snapshot|import|place|check|all
// match     each render file to a plan row by source name + source timecode in frames (the XML's file
//           timecode + the row's in-point), both read from the file name by --name-re (default
//           «<source>true<TC in frames>.<ext>», as the user's Resolve preset writes them); frame
//           count, size and rate probed. Run scripts/gridfix.mjs on the episodes BEFORE place.
// snapshot  the episodes as they are before the substitution (for check)
// place     per episode, Sequence.overwriteClip of the whole render at the row's start, V1 only: the
//           graded clip covers exactly its fragment, the camera audio on A1 is not targeted (a render
//           with audio of its own lands on the last audio track and is removed there)
// check     V1 = renders at the planned ranges; every other track, the markers and in/out as before
// Made for plans of mode "all": every fragment is a whole V1 item.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { callBridge } from './lib/prbridge.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const EXPECT = arg('expect'), PLAN = arg('plan'), XMLP = arg('xml'), DIR = arg('renders'), BIN = arg('bin'), TAG = arg('tag'), STEP = arg('step');
const NAME_RE = new RegExp(arg('name-re', '^(.*?)true(\\d+)\\.[^.]+$'));
if (!EXPECT || !PLAN || !XMLP || !DIR || !BIN || !TAG || !STEP) { console.error('missing args'); process.exit(2); }
const FPS = 25;
const fwd = (p) => p.replace(/\\/g, '/').replace(/\/$/, '');
const RDIR = fwd(DIR);
const MAP = PLAN.replace(/\.json$/, '') + ' — рендеры.json';
const SNAP = PLAN.replace(/\.json$/, '') + ' — до подстановки.json';
const plan = JSON.parse(readFileSync(PLAN, 'utf8'));
if (plan.mode !== 'all') { console.error('this substitution handles plans of mode "all" only'); process.exit(2); }
const EPS = [...new Set(plan.rows.map((r) => r.ep))];
const base = (n) => n.replace(/\.[^.]+$/, '');

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
  function R(x){ return Math.round(x*1000)/1000; }`;
async function run(body, opts = {}) {
  const raw = await callBridge('evalJson', [`(function(){ try { ${HEAD} ${body} } catch(e){ return JSON.stringify({error:String(e), line:e.line}); } })()`], { timeoutMs: 110000, ...opts });
  const r = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (r && r.error) throw new Error(JSON.stringify(r));
  return r;
}
const backupName = (s) => `_OLD_${s} (${TAG})`;

const steps = {
  async match() {
    const tc = tcStarts();
    const parsed = readdirSync(DIR).filter((f) => /\.(mp4|mov|mxf)$/i.test(f))
      .map((f) => { const m = f.match(NAME_RE); return m ? { f, src: m[1], tc: +m[2] } : { f, src: null }; });
    const used = new Set(), rows = [], errs = [];
    for (const r of plan.rows) {
      const want = tc[base(r.name)] + Math.round(r.sIn * FPS), n = Math.round((r.ge - r.gs) * FPS);
      const hit = parsed.filter((x) => x.src === base(r.name) && x.tc === want);
      if (hit.length !== 1) { errs.push(`${r.id} ${r.name} tc ${want}: ${hit.length} renders`); continue; }
      const pr = probe(`${RDIR}/${hit[0].f}`);
      used.add(hit[0].f);
      if (pr.frames !== n) errs.push(`${r.id} ${hit[0].f}: ${pr.frames} frames, plan ${n}`);
      if (pr.w !== 3840 || pr.h !== 2160 || Math.abs(pr.fps - FPS) > 1e-6) errs.push(`${r.id} ${hit[0].f}: ${pr.w}x${pr.h} @${pr.fps}`);
      rows.push({ ...r, render: hit[0].f, frames: pr.frames, probe: pr });
    }
    const extra = parsed.filter((x) => !used.has(x.f)).map((x) => x.f);
    writeFileSync(MAP, JSON.stringify({ renders: RDIR, rows }, null, 1));
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
    const d = dump(SNAP);
    console.log(`snapshot: ${d.seqs.filter((x) => x.v).length} episodes -> ${SNAP}`);
  },
  async import() {
    const m = JSON.parse(readFileSync(MAP, 'utf8'));
    const paths = m.rows.map((r) => `${RDIR}/${r.render}`);
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
      const rows = m.rows.filter((r) => r.ep === ep).sort((a, b) => a.a - b.a).map((x) => ({ id: x.id, render: x.render, a: x.a, b: x.b }));
      for (let pass = 1; pass <= 60; pass++) {
        const r = await run(`var S=seqNamed(${JSON.stringify(ep)}); if(!S) return JSON.stringify({error:'no sequence'});
          p.openSequence(S.sequenceID); var s=p.activeSequence; if(String(s.sequenceID)!==String(S.sequenceID)) return JSON.stringify({error:'not active'});
          var b=binNamed(${JSON.stringify(BIN)}), items={}; for(i=0;i<b.children.numItems;i++) items[String(b.children[i].name)]=b.children[i];
          var P=${JSON.stringify(rows)}, V=s.videoTracks[0], AT=s.audioTracks.numTracks-1, n=0, rem=0, note=[];
          if(s.audioTracks[AT].clips.numItems>0) return JSON.stringify({error:'the last audio track is not empty'});
          function at(tr,t0,nm){ for(var j=0;j<tr.clips.numItems;j++){ var c=tr.clips[j]; if(Math.abs(c.start.seconds-t0)<0.02 && String(c.name)===nm) return c; } return null; }
          for(k=0;k<P.length;k++){ var e=P[k];
            var have=at(V,e.a,e.render); if(have && Math.abs(have.end.seconds-e.b)<0.02) continue;
            if(n>=6){ rem++; continue; }
            var pi=items[e.render]; if(!pi){ note.push(e.id+': not in bin'); n++; continue; }
            s.overwriteClip(pi, e.a+0.001, 0, AT);
            var v=at(V,e.a,e.render);
            if(!v){ note.push(e.id+' not placed'); n++; continue; }
            if(Math.abs(v.end.seconds-e.b)>=0.02) note.push(e.id+': end '+R(v.end.seconds)+' != '+e.b);
            var ga=at(s.audioTracks[AT],e.a,e.render); if(ga) ga.remove(0,0);
            n++; }
          return JSON.stringify({done:n, remaining:rem, note:note, leftOnLastAudio:s.audioTracks[AT].clips.numItems});`);
        console.error(`  ${ep} pass ${pass}: placed ${r.done}, remaining ${r.remaining}${r.note.length ? ' NOTES ' + r.note.join('; ') : ''}${r.leftOnLastAudio ? ' AUDIO LEFT ' + r.leftOnLastAudio : ''}`);
        if (r.note.length || r.leftOnLastAudio) throw new Error('placement problem');
        if (r.remaining === 0) break;
      }
    }
  },
  async check() {
    const m = JSON.parse(readFileSync(MAP, 'utf8')), before = JSON.parse(readFileSync(SNAP, 'utf8'));
    const now = dump(PLAN.replace(/\.json$/, '') + ' — после подстановки.json');
    let bad = 0;
    for (const ep of EPS) {
      const a = before.seqs.find((x) => x.name === ep), b = now.seqs.find((x) => x.name === ep), errs = [];
      const want = m.rows.filter((r) => r.ep === ep).sort((x, y) => x.a - y.a);
      const key = (c) => `${c[0]}|${c[1]}|${c[2]}|${c[3]}`;
      const v1 = b.v[0];
      if (v1.length !== want.length) errs.push(`V1 holds ${v1.length} items, ${want.length} fragments`);
      want.forEach((w, k) => {
        const g = v1[k];
        if (!g || g[0] !== w.render || Math.abs(g[1] - w.a) > 0.011 || Math.abs(g[2] - w.b) > 0.011 || Math.abs(g[3]) > 0.011 || !fwd(g[5]).startsWith(RDIR))
          errs.push(`${w.id}: want ${w.render} ${w.a}-${w.b} in 0, got ${g ? g.slice(0, 4).join(' ') : 'nothing'}`);
      });
      a.v.slice(1).forEach((L, ti) => { if (JSON.stringify(L.map(key)) !== JSON.stringify((b.v[ti + 1] || []).map(key))) errs.push(`V${ti + 2} changed`); });
      a.a.forEach((L, ti) => { if (JSON.stringify(L.map(key)) !== JSON.stringify((b.a[ti] || []).map(key))) errs.push(`A${ti + 1} changed`); });
      if (JSON.stringify(a.markers) !== JSON.stringify(b.markers)) errs.push('markers changed');
      if (a.end !== b.end || a.inP !== b.inP || a.outP !== b.outP) errs.push(`end/in/out ${a.end}/${a.outP} -> ${b.end}/${b.outP}`);
      console.log(`check ${ep}: ${want.length} fragments; ${errs.length ? 'MISMATCH ' + errs.slice(0, 5).join(' ; ') : 'V1 is the graded renders at every planned range; audio, V2+, markers and in/out as before'}`);
      bad += errs.length;
    }
    if (bad) process.exit(1);
  },
};
const order = STEP === 'all' ? ['match', 'backup', 'snapshot', 'import', 'place', 'check'] : [STEP];
for (const st of order) await steps[st]();
