# A graded render laid back onto its source's own time: a file of the source's length, rate and timecode whose frame
# j0+k is render frame k and every other frame is black. A clip that plays its source through Time Remapping keeps
# its own remap keyframes (they are source media times) when its media becomes this file, so the ramp stays live.
#   python scripts/gradeconform.py <render_map.json> <out dir> <row id> [<row id> ...]
# ProRes 422 (the renders' profile), 10-bit, tagged Rec.709 throughout so Premiere passes the graded code values through.
import json, os, subprocess, sys
sys.stdout.reconfigure(encoding='utf-8')
mapp, outdir = sys.argv[1:3]
M = json.load(open(mapp, encoding='utf-8'))
rows = {r['id']: r for r in M['rows']}
os.makedirs(outdir, exist_ok=True)
for rid in sys.argv[3:]:
    r = rows[rid]
    src = r['path'].replace('\\\\', '\\')
    pr = json.loads(subprocess.run(['ffprobe', '-v', 'error', '-count_packets', '-select_streams', 'v:0', '-show_entries',
                                    'stream=nb_read_packets,r_frame_rate:stream_tags=timecode', '-of', 'json', src], capture_output=True, text=True).stdout)['streams'][0]
    total, rate, tc = int(pr['nb_read_packets']), pr['r_frame_rate'], (pr.get('tags') or {}).get('timecode', '00:00:00:00')
    w, h = r['w'], r['h']
    fsz = w * h * 4                                        # yuv422p10le
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-threads', '0', '-i', os.path.join(M['renders'], r['render']), '-f', 'rawvideo', '-pix_fmt', 'yuv422p10le', '-'],
                         capture_output=True).stdout
    assert len(raw) == fsz * r['frames'], (len(raw), r['frames'])
    black = (b'\x40\x00' * (w * h)) + (b'\x00\x02' * (w * h))          # Y 64, Cb = Cr = 512, little-endian 10-bit
    out = os.path.join(outdir, f"{r['name'][:-4]} грейд по времени исходника.mov")
    enc = subprocess.Popen(['ffmpeg', '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'yuv422p10le', '-s', f'{w}x{h}', '-r', rate,
                            '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-i', '-',
                            '-c:v', 'prores_ks', '-profile:v', '2', '-vendor', 'apl0', '-pix_fmt', 'yuv422p10le', '-timecode', tc,
                            '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-movflags', '+write_colr', out], stdin=subprocess.PIPE)
    for i in range(total):
        k = i - r['j0']
        enc.stdin.write(raw[k * fsz:(k + 1) * fsz] if 0 <= k < r['frames'] else black)
    enc.stdin.close(); enc.wait()
    print(f"{rid} {r['name']}: {total} frames @{rate} tc {tc}, graded {r['j0']}-{r['j0'] + r['frames'] - 1} -> {out}", flush=True)
