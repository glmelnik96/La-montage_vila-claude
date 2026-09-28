# Frame-exact check of a graded substitution: every frame of a timeline export (vidtest.mjs, frames
# from --at) against frames j-1, j, j+1 of the DaVinci render of its fragment (j = the frame the
# timeline should show). The Y plane only, so no colour conversion is involved. j must be the
# closest, and near zero: the timeline shows the graded file, in step, frame for frame.
#   python scripts/gradeverify.py <map.json from gradesub match> <episode> <at sec> <export.mov from tlexport.mjs>
import json, subprocess, sys
import numpy as np
sys.stdout.reconfigure(encoding='utf-8')
m = json.load(open(sys.argv[1], encoding='utf-8'))
ep, at, exp = sys.argv[2], float(sys.argv[3]), sys.argv[4]
W, H, FPS = 3840, 2160, 25
FS = W * H * 3 // 2


def ys(raw):
    return [np.frombuffer(raw[k * FS:k * FS + W * H], dtype=np.uint8).reshape(H, W).astype(np.float32) for k in range(len(raw) // FS)]


def frames_at(path, k, n):
    """frames k .. k+n-1 by their own timestamps (-copyts keeps them), not by a seek guess"""
    t = k / FPS - 0.001
    args = ['ffmpeg', '-v', 'error', '-ss', f'{max(0.0, t - 1.0):.3f}', '-copyts', '-i', path,
            '-vf', f'select=gte(t\\,{max(0.0, t):.4f})', '-fps_mode', 'passthrough', '-frames:v', str(n),
            '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-']
    return ys(subprocess.run(args, capture_output=True, check=True).stdout)


tl = ys(subprocess.run(['ffmpeg', '-v', 'error', '-i', exp, '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-'], capture_output=True, check=True).stdout)
f0 = round(at * FPS)
bad = 0
for i, y in enumerate(tl):
    f = f0 + i
    row = next(r for r in m['rows'] if r['ep'] == ep and round(r['a'] * FPS) <= f < round(r['b'] * FPS))
    j = f - round(row['a'] * FPS)
    lo = max(0, j - 1)
    cand = frames_at(f"{m['renders']}/{row['render']}", lo, 3)
    d = {lo + c: float(np.abs(y - g).mean()) for c, g in enumerate(cand)}
    best = min(d, key=d.get)
    ok = best == j and d[j] < 1.5
    bad += not ok
    print(f"{ep} {f / FPS:7.2f} {row['id']} frame {j}/{row['frames']}: " + '  '.join(f"{'*' if k == j else ' '}{k}:{v:.2f}" for k, v in d.items()) + ('' if ok else '   <-- CHECK'))
sys.exit(1 if bad else 0)
