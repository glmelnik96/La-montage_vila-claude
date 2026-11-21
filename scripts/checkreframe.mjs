// Look at what you actually built. Reads the Motion values Premiere STORED on a
// vertical sequence, inverts them back into a source rectangle, crops that
// rectangle out of the source media and tiles one frame per clip.
//
// This is the only honest check. The panel host cannot hand back a rendered
// composite (getFrameSources returns clip metadata, not pixels), and matching
// numbers prove only that the numbers matched — they cannot show you that a wide
// two-shot got framed on the person who is not talking.
//
//   node scripts/checkreframe.mjs --src <media> --seq "Reel 1" [--out gen-out/frames/built]
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { probeSize, unmotion, geom } from './vframe.mjs';

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : d;
};

const src = arg('src'), seq = arg('seq');
if (!src || !seq) { console.error('need --src <media> --seq <sequence name>'); process.exit(2); }
const dir = arg('out', 'gen-out/frames/built');

mkdirSync('gen-out/tmp', { recursive: true });
writeFileSync('gen-out/tmp/_cr.js', `
var proj = app.project, s = null;
for (var i = 0; i < proj.sequences.numSequences; i++)
  if (String(proj.sequences[i].name) === ${JSON.stringify(seq)}) s = proj.sequences[i];
if (!s) JSON.stringify({ ok: false, err: 'sequence not found' });
else {
  var vt = s.videoTracks[0], out = [];
  for (var i = 0; i < vt.clips.numItems; i++) {
    var c = vt.clips[i], mo = null;
    for (var k = 0; k < c.components.numItems; k++)
      if (String(c.components[k].displayName) === 'Motion') mo = c.components[k];
    var sc = null, po = null;
    if (mo) for (var p = 0; p < mo.properties.numItems; p++) {
      var nm = String(mo.properties[p].displayName);
      if (nm === 'Scale') sc = mo.properties[p].getValue();
      if (nm === 'Position') po = mo.properties[p].getValue();
    }
    out.push({ i: i, src: +c.inPoint.seconds.toFixed(3), srcEnd: +c.outPoint.seconds.toFixed(3), scale: sc, pos: po });
  }
  JSON.stringify({ ok: true, w: s.frameSizeHorizontal, h: s.frameSizeVertical, n: vt.clips.numItems, clips: out });
}`, 'utf8');

const r = JSON.parse(execFileSync('node', ['scripts/_ev.mjs', 'gen-out/tmp/_cr.js'], { encoding: 'utf8' }));
if (!r.ok) { console.error(r); process.exit(1); }
if (r.w !== 1080 || r.h !== 1920) { console.error(`NOT VERTICAL: ${r.w}x${r.h}`); process.exit(1); }

const { w: srcW, h: srcH } = probeSize(src);

// Wipe first. A shorter reel leaves the previous run's frames behind and the
// contact sheet then silently shows a mixture of two different sequences.
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });

let n = 0;
for (const c of r.clips) {
  const g = geom(srcW, srcH, c.scale);
  const { u, v } = unmotion(srcW, srcH, c.scale, c.pos[0], c.pos[1]);
  const fw = g.visibleW, fh = Math.min(g.visibleH, 1);
  const t = (c.src + c.srcEnd) / 2;
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', String(t), '-i', src, '-frames:v', '1',
    '-vf', `crop=in_w*${fw.toFixed(4)}:in_h*${fh.toFixed(4)}:in_w*${(u - fw / 2).toFixed(4)}:in_h*${Math.max(0, v - fh / 2).toFixed(4)},scale=180:320`,
    `${dir}/c_${String(n++).padStart(3, '0')}.png`]);
}
const cols = Math.min(10, n);
const outPng = `${dir}_sheet.png`;
execFileSync('ffmpeg', ['-v', 'error', '-y', '-framerate', '1', '-i', `${dir}/c_%03d.png`,
  '-filter_complex', `tile=${cols}x${Math.ceil(n / cols)}:padding=4:color=0x202020`,
  '-frames:v', '1', outPng]);
console.log(`${seq}: ${n} clips -> ${outPng}  (READ this image; numbers alone prove nothing)`);
