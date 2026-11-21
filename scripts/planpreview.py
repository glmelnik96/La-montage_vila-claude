# Render an assemble.mjs plan to a watchable file WITHOUT Premiere: the picture as the
# tracks will show it (V1, the B-roll layer above it, full-frame cards, an alpha overlay),
# the audio of the speaking pieces, and the subtitles burnt in.
#
#   python scripts/planpreview.py --layout gen-out/<job>/layout.json \
#       --plan gen-out/<job>/expected.json [--cards gen-out/<job>/cards.json] \
#       [--srt gen-out/<job>/subs.srt] --out preview.mp4 [--from 0] [--to 900] [--jobs 3]
#
# Why it earns its place: a plan that matches itself can still be a bad film. This shows the
# pace, what covers what, and where the cut goes silent — in minutes, before the sequence is
# built, and it is what the user watches to approve the edit. It is a MODEL of the timeline:
# a still that does not fill the frame is letterboxed here, while Premiere shows the track
# below it. Check anything that matters on a real exported frame.
#
# plan rows (expected.json from assemble.mjs): {clip, ns, ne, sIn, role, tr}
#   role 'canvas'/'win' -> V1, 'v2' -> the layer above it; every other role is ignored
#   (the alternate takes and the B-roll library live past the end of the cut).
# cards rows: {name, st, en, track} — track 0 full-frame on V1, 2 = overlay with alpha.
import hashlib, json, os, re, subprocess, sys, tempfile
from concurrent.futures import ThreadPoolExecutor


def arg(k, d=None):
    return sys.argv[sys.argv.index('--' + k) + 1] if '--' + k in sys.argv else d


LAYOUT, PLAN, CARDS, SRT = arg('layout'), arg('plan'), arg('cards'), arg('srt')
OUT = arg('out', 'preview.mp4')
GRAPH = arg('graphics', os.path.dirname(CARDS or '') or '.')
T0, T1 = float(arg('from', 0)), float(arg('to', 1e9))
JOBS, W, H, FPS = int(arg('jobs', 3)), int(arg('width', 1280)), int(arg('height', 720)), float(arg('fps', 25))
if not LAYOUT or not PLAN:
    sys.exit('usage: planpreview.py --layout layout.json --plan expected.json --out preview.mp4')
TMP = os.path.join(tempfile.gettempdir(), 'planpreview_' + os.path.basename(OUT).replace('.', '_'))
os.makedirs(TMP, exist_ok=True)

L = json.load(open(LAYOUT, encoding='utf-8'))
V = (json.loads(L) if isinstance(L, str) else L)['v']
E = json.load(open(PLAN, encoding='utf-8'))
C = json.load(open(CARDS, encoding='utf-8')) if CARDS else []
STILL = 3600.0        # a still reports this as its source in-point


def is_still(r):
    return abs(V[r['clip']]['sIn'] - STILL) < 1.0


speak = [r for r in E if r['role'] == 'canvas']
END = min(T1, max([r['ne'] for r in speak] + [c['en'] for c in C] + [0]))
base, over, plate = [], [], []
for r in E:
    item = {'a': r['ns'], 'b': r['ne'], 'path': V[r['clip']]['path'], 'sIn': r['sIn'], 'still': is_still(r)}
    if r['role'] in ('canvas', 'win'):
        base.append(item)
    elif r['role'] == 'v2':
        over.append(item)
for c in C:
    (plate if c.get('track') == 2 else base).append({'a': c['st'], 'b': c['en'], 'still': True, 'sIn': 0.0,
                                                     'path': os.path.join(GRAPH, c['name'])})

edges = sorted({T0, END} | {x for it in base + over + plate for x in (it['a'], it['b']) if T0 < x < END})
segs = []
for a, b in zip(edges, edges[1:]):
    if b - a < 1 / FPS:
        continue
    mid = (a + b) / 2
    top = next((o for o in over if o['a'] <= mid < o['b']), None) or next((x for x in base if x['a'] <= mid < x['b']), None)
    segs.append({'a': a, 'b': b, 'src': top, 'plate': next((p for p in plate if p['a'] <= mid < p['b']), None)})
print(f'{len(segs)} segments, {END - T0:.1f} s, {sum(1 for s in segs if not s["src"])} with no picture (black)')


def render(i_s):
    i, s = i_s
    dur, src = s['b'] - s['a'], s['src']
    # a segment that starts inside a piece (after a cutaway, a card, --from) plays the piece from
    # there, not from its head
    off = src['sIn'] + (s['a'] - src['a']) if src and not src['still'] else 0.0
    # cached by what the segment shows, so a changed plan never reuses a stale render
    key = json.dumps([round(dur, 3), src and src['path'], round(off, 3), src and src['still'],
                      s['plate'] and s['plate']['path'], W, H, FPS])
    out = os.path.join(TMP, hashlib.sha1(key.encode('utf-8')).hexdigest()[:16] + '.mp4')
    if os.path.exists(out) and os.path.getsize(out) > 1000:
        return out
    vf = (f'scale={W}:{H}:force_original_aspect_ratio=decrease,pad={W}:{H}:(ow-iw)/2:(oh-ih)/2,'
          f'fps={FPS},setsar=1,format=yuv420p')
    cmd = ['ffmpeg', '-v', 'error', '-y']
    if not src:
        cmd += ['-f', 'lavfi', '-i', f'color=black:s={W}x{H}:r={FPS}:d={dur:.3f}']
    elif src['still']:
        cmd += ['-loop', '1', '-t', f'{dur:.3f}', '-i', src['path']]
    else:
        cmd += ['-ss', f'{off:.3f}', '-t', f'{dur:.3f}', '-i', src['path']]
    if s['plate']:
        cmd += ['-i', s['plate']['path'], '-filter_complex',
                f'[0:v]{vf}[v];[1:v]scale={W}:{H}[p];[v][p]overlay=0:0']
    else:
        cmd += ['-vf', vf]
    cmd += ['-an', '-t', f'{dur:.3f}', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
            '-video_track_timescale', '12800', out]
    subprocess.run(cmd, check=True, capture_output=True)
    return out


with ThreadPoolExecutor(max_workers=JOBS) as ex:
    files = list(ex.map(render, enumerate(segs)))
lst = os.path.join(TMP, 'list.txt')
with open(lst, 'w', encoding='utf-8') as f:
    for p in files:
        f.write("file '" + p.replace('\\', '/') + "'\n")
vid = os.path.join(TMP, 'video.mp4')
subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', lst, '-c', 'copy', vid], check=True)

def loud_channel(path, at):
    """Which source channel carries the voice — a lav on one input leaves the other silent, and a
    plain downmix then loses 6 dB. None when both channels carry sound."""
    out = subprocess.run(['ffmpeg', '-hide_banner', '-nostats', '-ss', f'{at:.1f}', '-t', '15', '-i', path,
                          '-af', 'astats=measure_perchannel=RMS_level:measure_overall=none', '-f', 'null', '-'],
                         capture_output=True, text=True).stderr
    rms = [float(x) if x != '-inf' else -120.0
           for x in re.findall(r'RMS level dB:\s*(-?[\d.]+|-inf)', out)]
    if len(rms) < 2:
        return None
    hi = max(range(len(rms)), key=lambda i: rms[i])
    return hi if rms[hi] - min(rms) > 18 else None


CH = {}
clips = []
for r in sorted(speak, key=lambda x: x['ns']):
    if r['ne'] <= T0 or r['ns'] >= END or is_still(r):
        continue
    path = V[r['clip']]['path']
    if path not in CH:
        CH[path] = loud_channel(path, r['sIn'] + 1)
    cut = max(0.0, T0 - r['ns'])           # a piece already running at --from starts mid-piece
    row = {'path': path, 'start': r['ns'] + cut - T0, 'in': r['sIn'] + cut, 'out': r['sIn'] + (r['ne'] - r['ns'])}
    if CH[path] is not None:
        row['ch'] = CH[path]
    clips.append(row)
one = sum(1 for v in CH.values() if v is not None)
print(f'audio: {len(CH)} sources, {one} with the voice on one channel only')
cj, wav = os.path.join(TMP, 'clips.json'), os.path.join(TMP, 'audio.wav')
json.dump(clips, open(cj, 'w', encoding='utf-8'))
subprocess.run(['node', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'mixdown.mjs'),
                '--clips', cj, '--out', wav, '--sr', '48000'], check=True)

cmd = ['ffmpeg', '-v', 'error', '-y', '-i', vid, '-i', wav]
if SRT:                                   # ffmpeg's subtitles filter wants its own escaping
    esc = os.path.abspath(SRT).replace('\\', '/').replace(':', r'\:')
    cmd += ['-vf', f"subtitles='{esc}':force_style='FontName=Arial,FontSize=18,Outline=1,MarginV=28'"]
# apad: the film may end on a silent card, and -shortest would cut the picture to the audio
cmd += ['-map', '0:v', '-map', '1:a', '-af', 'apad', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22',
        '-c:a', 'aac', '-b:a', '160k', '-shortest', OUT]
subprocess.run(cmd, check=True)
print(f'WROTE {OUT}  {os.path.getsize(OUT) / 1e6:.0f} MB')
