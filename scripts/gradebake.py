# Bake a clip that an edit plays through Time Remapping (a speed ramp the DOM cannot see or set) from its graded
# render: a new file at the sequence's rate whose frame i is the render frame the edit showed at its timeline frame i.
#   python scripts/gradebake.py <render_map.json> <bake.json> <out dir> [--fps 25]
# bake.json: [{"id": "<plan row id>", "frames": [<source frame per timeline frame>, ...], "name": "<file stem>"}, ...]
# The source frames come from a frame map of the edit (frames it showed, matched on a render) and, for frames hidden
# under a higher track, from the clip's remap keyframes in the saved project. Render frame = source frame - j0.
# Output: ProRes 422 (the renders' own profile), 10-bit, the render's size, tagged Rec.709 (primaries, transfer and
# matrix), so Premiere reads it as the cameras' Rec. 709 and passes the graded code values through.
import json, os, subprocess, sys
import numpy as np
sys.stdout.reconfigure(encoding='utf-8')
mapp, bakep, outdir = sys.argv[1:4]
FPS = sys.argv[sys.argv.index('--fps') + 1] if '--fps' in sys.argv else '25'
M = json.load(open(mapp, encoding='utf-8'))
rows = {r['id']: r for r in M['rows']}
os.makedirs(outdir, exist_ok=True)
for b in json.load(open(bakep, encoding='utf-8')):
    r = rows[b['id']]
    src = os.path.join(M['renders'], r['render'])
    w, h = (r['h'], r['w']) if r.get('transpose') else (r['w'], r['h'])
    k = [f - r['j0'] for f in b['frames']]
    if min(k) < 0 or max(k) >= r['frames']:
        print(f"{b['id']}: frames {min(b['frames'])}-{max(b['frames'])} are not all in the render ({r['j0']}-{r['j0'] + r['frames'] - 1})"); sys.exit(1)
    fsz = w * h * 2 * 2                                   # yuv422p10le: Y w*h + Cb, Cr w/2*h each, 2 bytes a sample
    vf = [] if not r.get('transpose') else ['-vf', f"transpose={r['transpose']}"]
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-threads', '0', '-noautorotate', '-i', src, *vf, '-f', 'rawvideo', '-pix_fmt', 'yuv422p10le', '-'],
                         capture_output=True).stdout
    frames = [raw[i * fsz:(i + 1) * fsz] for i in range(len(raw) // fsz)]
    assert len(frames) == r['frames'], (len(frames), r['frames'])
    out = os.path.join(outdir, f"{b['name']}.mov")
    enc = subprocess.Popen(['ffmpeg', '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'yuv422p10le', '-s', f'{w}x{h}', '-r', FPS,
                            '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-i', '-',
                            '-c:v', 'prores_ks', '-profile:v', '2', '-vendor', 'apl0', '-pix_fmt', 'yuv422p10le',
                            '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-movflags', '+write_colr', out], stdin=subprocess.PIPE)
    for i in k: enc.stdin.write(frames[i])
    enc.stdin.close(); enc.wait()
    n = int(subprocess.run(['ffprobe', '-v', 'error', '-count_packets', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', out],
                           capture_output=True, text=True).stdout.strip() or 0)
    print(f"{b['id']} {r['name']}: {len(k)} frames from render frames {min(k)}-{max(k)} -> {out} ({n} frames, {w}x{h} @{FPS})")
