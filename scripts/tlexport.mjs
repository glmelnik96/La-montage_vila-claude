// Export a few frames of a sequence as H.264 (Rec.709, "Match Source") from a throwaway clone, to
// compare the timeline's code values with a source file (scripts/gradeverify.py). A JPEG export
// is no good for that: it converts Rec.709 to sRGB (shadows and mids come out darker by that curve).
// Refuses to run unless --expect matches the focused project.
//   node scripts/tlexport.mjs --expect <path part> --seq "<name>" --at <sec> --frames 5 --out <file.mov>
import { existsSync, statSync, unlinkSync } from 'node:fs';
import { callBridge } from './lib/prbridge.mjs';
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const EXPECT = arg('expect'), SEQ = arg('seq'), AT = +arg('at'), N = +arg('frames', 5), OUT = arg('out');
const PRESET = 'C:/Program Files/Adobe/Adobe Premiere Pro 2026/MediaIO/systempresets/3F3F3F3F_4D6F6F56/H264 Match Source - High bitrate.epr';
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const run = async (b) => { const raw = await callBridge('evalJson', [`(function(){try{var p=app.project,i;
  if(String(p.path).indexOf(${JSON.stringify(EXPECT)})<0) return JSON.stringify({error:'focused project is '+p.path});
  function seqNamed(nm){ for(var j=0;j<p.sequences.numSequences;j++){ if(String(p.sequences[j].name)===nm) return p.sequences[j]; } return null; }
  ${b}}catch(e){return JSON.stringify({error:String(e),line:e.line});}})()`], { timeoutMs: 110000 });
  const r = typeof raw === 'string' ? JSON.parse(raw) : raw; if (r.error) throw new Error(JSON.stringify(r)); return r; };
const tmp = `_vidtest ${SEQ}`;
if (existsSync(OUT)) unlinkSync(OUT);
const f0 = Math.round(AT * 25) / 25 + 0.001;
console.log(await run(`var S=seqNamed(${JSON.stringify(SEQ)}), N=seqNamed(${JSON.stringify(tmp)});
  if(!N){ var b={}; for(i=0;i<p.sequences.numSequences;i++) b[String(p.sequences[i].sequenceID)]=1; S.clone();
    for(i=0;i<p.sequences.numSequences;i++){ if(!b[String(p.sequences[i].sequenceID)]) N=p.sequences[i]; } N.name=${JSON.stringify(tmp)}; }
  p.openSequence(N.sequenceID); N.setInPoint(${f0}); N.setOutPoint(${f0 + N * 0.04});
  var ok=N.exportAsMediaDirect(new File(${JSON.stringify(OUT)}).fsName, new File(${JSON.stringify(PRESET)}).fsName, app.encoder.ENCODE_IN_TO_OUT);
  return JSON.stringify({ok:String(ok)});`));
let last = -1, still = 0;
while (still < 3) { await pause(1000); const sz = existsSync(OUT) ? statSync(OUT).size : 0; still = sz === last && sz > 0 ? still + 1 : 0; last = sz; }
console.log(await run(`var S=seqNamed(${JSON.stringify(SEQ)}), N=seqNamed(${JSON.stringify(tmp)}); p.openSequence(S.sequenceID); if(N) p.deleteSequence(N); return JSON.stringify({deleted:true});`));
console.log(await run(`return JSON.stringify({clonesLeft: seqNamed(${JSON.stringify(tmp)}) ? 1 : 0});`));
console.log(`${OUT}: ${last} bytes`);
