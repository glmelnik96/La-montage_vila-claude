// The 9:16 reframe arithmetic, in one place, with the visible fraction printed.
//
// THE TRAP: scalePct is NOT the fraction of the source you see. Scale 100 renders
// the source at native pixel size; the vertical frame is a WINDOW onto it. So a
// 3840-wide source at scalePct 88.889 is drawn 3413 px wide and a 1080-wide frame
// shows 1080/3413 = 31.6% of the image width — not 88.9%. Always read `visible`
// from this tool instead of reasoning about scalePct directly.
//
// Position is normalised 0..1 with 0.5 = centred, and it moves the IMAGE, so it
// runs opposite to the point you want to see. Values outside 0..1 are normal and
// legal (range is [-5,5]): framing a face near the edge of a pushed-in wide shot
// genuinely needs posX ≈ 2.
//
//   node scripts/vframe.mjs --src <media> --scale 88.889 --u 0.61 [--v 0.5]
//   node scripts/vframe.mjs plan --src <media> --clips <clips.json> --map <map.json> \
//        --name "Reel 1" --from "_wip Reel 1" [--out gen-out/tmp/reframe.json]
//
// clips.json: [{ "idx":0, "cam":"A" }, ...]   map.json: { "A":{"u":0.61},"W":{"u":0.771,"v":0.4832,"scale":133} }
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const TW = 1080, TH = 1920;

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : d;
};

export function probeSize(src) {
  const s = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height', '-of', 'json', src], { encoding: 'utf8' })).streams[0];
  return { w: s.width, h: s.height };
}

// Scale that makes the source exactly fill the frame HEIGHT (the usual starting
// point for a landscape source: full height, crop the sides).
export const fillHeightScale = (srcH) => +(TH / srcH * 100).toFixed(3);

export function geom(srcW, srcH, scalePct) {
  const S = scalePct / 100;
  return {
    drawnW: Math.round(srcW * S), drawnH: Math.round(srcH * S),
    visibleW: +(TW / (srcW * S)).toFixed(4),   // fraction of source WIDTH inside the frame
    visibleH: +(TH / (srcH * S)).toFixed(4),   // fraction of source HEIGHT inside the frame
    kx: srcW * S / TW, ky: srcH * S / TH
  };
}

// u,v = the point of the SOURCE (0..1) you want at the centre of the frame.
export function motion(srcW, srcH, scalePct, u, v = 0.5) {
  const g = geom(srcW, srcH, scalePct);
  return {
    scalePct: +scalePct.toFixed(3),
    posX: +(0.5 - (u - 0.5) * g.kx).toFixed(4),
    posY: +(0.5 - (v - 0.5) * g.ky).toFixed(4)
  };
}

// Invert Motion back to the source point — used to verify what Premiere actually stored.
export function unmotion(srcW, srcH, scalePct, posX, posY) {
  const g = geom(srcW, srcH, scalePct);
  return { u: +(0.5 - (posX - 0.5) / g.kx).toFixed(4), v: +(0.5 - (posY - 0.5) / g.ky).toFixed(4) };
}

// A wide/two-shot is a brief cutaway while somebody keeps talking. Frame it on the
// person the SURROUNDING close-ups are on, not on whoever dominates the reel overall
// — otherwise every reel that changes speaker halfway puts half its wides on a
// silent face.
export function nearestSpeaker(clips, i, wideCam = 'W') {
  for (let d = 1; d < clips.length; d++) {
    const a = clips[i - d], b = clips[i + d];
    if (a && a.cam !== wideCam) return a.cam;
    if (b && b.cam !== wideCam) return b.cam;
  }
  return null;
}

if (process.argv[1] && process.argv[1].endsWith('vframe.mjs')) {
  const src = arg('src');
  if (!src) { console.error('need --src <media>'); process.exit(2); }
  const { w: srcW, h: srcH } = probeSize(src);

  if (process.argv[2] === 'plan') {
    const clips = JSON.parse(readFileSync(arg('clips'), 'utf8'));
    const map = JSON.parse(readFileSync(arg('map'), 'utf8'));
    const wideCam = arg('wide', 'W');
    const baseScale = +arg('scale', fillHeightScale(srcH));
    const items = clips.map((c, i) => {
      let key = c.cam;
      if (c.cam === wideCam) {
        const near = nearestSpeaker(clips, i, wideCam);
        key = near ? `${wideCam}_${near}` : wideCam;
      }
      const m = map[key] || map[c.cam];
      if (!m) throw new Error(`no framing for camera "${key}" — add it to the map`);
      const sc = m.scale !== undefined ? m.scale : baseScale;
      return { trackIndex: 0, clipIndex: c.idx, ...motion(srcW, srcH, sc, m.u, m.v !== undefined ? m.v : 0.5) };
    });
    const plan = { newName: arg('name'), targetW: TW, targetH: TH, expectedSequenceName: arg('from'), items };
    const out = arg('out', 'gen-out/tmp/reframe.json');
    mkdirSync('gen-out/tmp', { recursive: true });
    writeFileSync(out, JSON.stringify(plan, null, 2), 'utf8');
    console.log(`${out}  ${items.length} items  source ${srcW}x${srcH}`);
    process.exit(0);
  }

  const scalePct = +arg('scale', fillHeightScale(srcH));
  const u = +arg('u', 0.5), v = +arg('v', 0.5);
  const g = geom(srcW, srcH, scalePct);
  const m = motion(srcW, srcH, scalePct, u, v);
  console.log(`source      ${srcW}x${srcH}   frame ${TW}x${TH}`);
  console.log(`scalePct    ${m.scalePct}  -> drawn ${g.drawnW}x${g.drawnH}`);
  console.log(`visible     ${(g.visibleW * 100).toFixed(1)}% of source width, ${(Math.min(g.visibleH, 1) * 100).toFixed(1)}% of source height`);
  console.log(`centre on   u=${u} v=${v}`);
  console.log(`posX ${m.posX}   posY ${m.posY}`);
  if (m.posX < 0 || m.posX > 1) console.log(`note        posX outside 0..1 is expected here (legal range -5..5)`);
}
