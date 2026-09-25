// Survey the shots of the ACTIVE sequence so you can SEE what the cameras are.
// In a flattened multicam export every clip boundary on the timeline is a camera
// switch, so one frame per clip is a complete inventory of the angles.
//
// Output is a numbered contact sheet you READ. Do not guess camera identity from
// filenames or from luma heuristics copied out of another project — the lighting,
// the seating and the number of angles differ every time.
//
//   node scripts/shots.mjs --src <media> [--out gen-out/frames/shots] [--every 1] [--grid 10]
//
// Then measure a face: crop one frame and binary-search the horizontal centre.
//   node scripts/shots.mjs probe --src <media> --at <sec> --u 0.61 --scale 88.889
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : d;
};

// The panel host exposes clip in/out points; for a 1:1 flattened export the
// timeline time equals the source time, but read BOTH and never assume.
const CLIPS_JSX = `
var s = app.project.activeSequence;
if (!s) JSON.stringify({ok:false, err:'no active sequence'});
else {
  var vt = s.videoTracks[0], out = [];
  for (var i = 0; i < vt.clips.numItems; i++) {
    var c = vt.clips[i];
    out.push({ i: i,
      tl: +c.start.seconds.toFixed(3), tlEnd: +c.end.seconds.toFixed(3),
      src: +c.inPoint.seconds.toFixed(3), srcEnd: +c.outPoint.seconds.toFixed(3) });
  }
  JSON.stringify({ ok: true, name: String(s.name), w: s.frameSizeHorizontal,
    h: s.frameSizeVertical, n: vt.clips.numItems, clips: out });
}`;

export function activeClips() {
  mkdirSync('gen-out/tmp', { recursive: true });
  writeFileSync('gen-out/tmp/_clips.js', CLIPS_JSX, 'utf8');
  return JSON.parse(execFileSync('node', ['scripts/_ev.mjs', 'gen-out/tmp/_clips.js'], { encoding: 'utf8' }));
}

function sheet(src, times, dir, grid) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  times.forEach((t, n) => {
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', String(t), '-i', src,
      '-frames:v', '1', '-vf', 'scale=320:-1', `${dir}/f_${String(n).padStart(3, '0')}.png`]);
  });
  const cols = Math.min(grid, times.length);
  const outPng = `${dir}_sheet.png`;
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-framerate', '1', '-i', `${dir}/f_%03d.png`,
    '-filter_complex', `tile=${cols}x${Math.ceil(times.length / cols)}:padding=4:color=0x202020`,
    '-frames:v', '1', outPng]);
  return outPng;
}

if (process.argv[1] && process.argv[1].endsWith('shots.mjs')) {
  const src = arg('src');
  if (!src) { console.error('need --src <media>'); process.exit(2); }

  if (process.argv[2] === 'probe') {
    // Render exactly what a given u / scalePct would show, so a face position is
    // confirmed by looking rather than by arithmetic alone.
    const t = +arg('at'), u = +arg('u', 0.5), v = +arg('v', 0.5), S = +arg('scale', 100) / 100;
    const ex = execFileSync;
    const meta = JSON.parse(ex('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height', '-of', 'json', src], { encoding: 'utf8' })).streams[0];
    const fw = 1080 / (meta.width * S), fh = 1920 / (meta.height * S);
    mkdirSync('gen-out/frames', { recursive: true });
    const out = `gen-out/frames/probe_${t}.png`;
    ex('ffmpeg', ['-v', 'error', '-y', '-ss', String(t), '-i', src, '-frames:v', '1',
      '-vf', `crop=in_w*${fw.toFixed(4)}:in_h*${Math.min(fh, 1).toFixed(4)}:in_w*${(u - fw / 2).toFixed(4)}:in_h*${Math.max(0, v - fh / 2).toFixed(4)},scale=270:480`,
      out]);
    console.log(`${out}  source ${meta.width}x${meta.height}  visible ${(fw * 100).toFixed(1)}% wide x ${(Math.min(fh, 1) * 100).toFixed(1)}% tall`);
    process.exit(0);
  }

  const r = activeClips();
  if (!r.ok) { console.error(r); process.exit(1); }
  const every = +arg('every', 1);
  const picked = r.clips.filter((_, i) => i % every === 0);
  const times = picked.map(c => (c.src + c.srcEnd) / 2);
  const png = sheet(src, times, arg('out', 'gen-out/frames/shots'), +arg('grid', 10));
  console.log(`${r.name}  ${r.w}x${r.h}  ${r.n} clips -> ${png}`);
  picked.forEach((c, n) => console.log(`  ${String(n).padStart(3)}  clip ${c.i}  tl ${c.tl}..${c.tlEnd}  src ${c.src}..${c.srcEnd}  mid ${times[n].toFixed(2)}`));
}
