# Match graded renders to the rows of a grading plan by their pictures, not their names, and find each render's exact
# place in its source: render frame k = source frame j0 + k.
#   python scripts/gradematch.py <plan.json> <renders dir> <out map.json> [--handles 10] [--pattern "\.mov$"]
# Why pictures: Resolve names Individual clips by the timeline and the source TIMECODE, and its idea of a file's
# timecode can differ from the file's own track (an FX3 MP4 was 15 frames off), while phone and GoPro files all start
# at 00:00:00:00. A grade changes every level, so frames are compared by their gradients (128x72 grey, zero-mean,
# normalised): a graded frame scores 0.95-1.0 against its own source frame, a neighbour lower.
# For each render: size, rate, SAR, colour tags, frame count; the candidate rows have the same size and rate and a
# frame count of their piece + up to 2 x handles (clamped at the media's ends; +-6 frames for a source at another rate
# than the timeline); the best offset j0 is searched around the expected one (+-30 frames) over every frame of the
# render. A render whose width and height are swapped was rotated by Resolve (a rotation flag that Premiere ignores):
# it is matched turned back both ways, and the map keeps the transpose that undoes it.
import json, os, re, subprocess, sys
import numpy as np
sys.stdout.reconfigure(encoding='utf-8')
planp, rdir, outp = sys.argv[1:4]
H = int(sys.argv[sys.argv.index('--handles') + 1]) if '--handles' in sys.argv else 10
pat = re.compile(sys.argv[sys.argv.index('--pattern') + 1] if '--pattern' in sys.argv else r'\.(mov|mp4|mxf)$', re.I)
plan = json.load(open(planp, encoding='utf-8'))
TW, TH, SEARCH = 128, 72, 30


def probe(p):
    j = json.loads(subprocess.run(['ffprobe', '-v', 'error', '-count_packets', '-select_streams', 'v:0', '-show_entries',
                                   'format=duration:stream=width,height,r_frame_rate,nb_read_packets,sample_aspect_ratio,color_transfer,color_primaries,color_space,codec_name,profile:stream_tags=timecode',
                                   '-of', 'json', p], capture_output=True, text=True).stdout)
    v = j['streams'][0]; n, d = map(int, v['r_frame_rate'].split('/'))
    return {'w': v['width'], 'h': v['height'], 'fps': n / d, 'frames': int(v['nb_read_packets']), 'sar': v.get('sample_aspect_ratio'),
            'trc': v.get('color_transfer'), 'prim': v.get('color_primaries'), 'mat': v.get('color_space'), 'codec': v.get('codec_name'),
            'profile': v.get('profile'), 'tc': (v.get('tags') or {}).get('timecode'), 'dur': float(j['format']['duration'])}


def thumbs(p, start=None, count=None, fps=None, transpose=None):
    # frames are picked by their own timestamps (seek 1 s early, -copyts, select t >= start): an input seek alone
    # landed one frame early on these long-GOP H.264 files, which read as a +1 frame offset everywhere
    a = ['ffmpeg', '-v', 'error', '-threads', '0', '-noautorotate']
    vf = ''
    if start:
        a += ['-ss', f'{max(0.0, start / fps - 1.0):.5f}', '-copyts']
        vf = f"select='gte(t\,{(start - 0.5) / fps:.6f})',"
    a += ['-i', p]
    if transpose is not None: vf += f'transpose={transpose},'
    a += ['-vf', vf + f'scale={TW}:{TH}:flags=area,format=gray', '-fps_mode', 'passthrough']
    if count: a += ['-frames:v', str(count)]
    a += ['-f', 'rawvideo', '-']
    x = np.frombuffer(subprocess.run(a, capture_output=True).stdout, np.uint8).reshape(-1, TH, TW).astype(np.float32)
    g = np.abs(np.diff(x, axis=2))[:, :-1, :] + np.abs(np.diff(x, axis=1))[:, :, :-1]
    g = g.reshape(len(g), -1); g -= g.mean(1, keepdims=True)
    return g / (np.linalg.norm(g, axis=1, keepdims=True) + 1e-9)


srcinfo, rinfo = {}, {}
for r in plan['rows']:
    if r['path'] not in srcinfo: srcinfo[r['path']] = probe(r['path'])
files = sorted(f for f in os.listdir(rdir) if pat.search(f))
for f in files: rinfo[f] = probe(os.path.join(rdir, f))
print(f'{len(files)} renders, {len(plan["rows"])} rows, {len(srcinfo)} sources', flush=True)
rows = sorted(plan['rows'], key=lambda r: r['gs'])
for r in rows:
    s = srcinfo[r['path']]; fps = s['fps']
    j_in = int(round(r['sIn'] * fps)); n = int(round(r['sd'] * fps))
    j_out = min(s['frames'], j_in + n)
    r['_exp0'] = max(0, j_in - H); r['_expn'] = min(s['frames'], j_out + H) - r['_exp0']
cands = []
rthumb = {}
for f in files:
    ri = rinfo[f]
    for r in rows:
        s = srcinfo[r['path']]
        if abs(s['fps'] - ri['fps']) > 0.01: continue
        if (s['w'], s['h']) == (ri['w'], ri['h']): rot = None
        elif (s['w'], s['h']) == (ri['h'], ri['w']): rot = 'rot'            # Resolve honoured a rotation flag
        else: continue
        if abs(ri['frames'] - r['_expn']) > (2 if abs(s['fps'] - 50) < 0.01 or abs(s['fps'] - 25) < 0.01 else 6): continue
        cands.append((f, r['id'], rot))
print(f'{len(cands)} candidate pairs by size, rate and length', flush=True)
byrow = {r['id']: r for r in rows}
scores = {}
srccache = {}
for f, rid, rot in cands:
    r = byrow[rid]; s = srcinfo[r['path']]; ri = rinfo[f]
    tps = [None] if rot is None else [1, 2]          # transpose 1 = 90 deg clockwise, 2 = counter-clockwise
    for tp in tps:
        if (f, tp) not in rthumb: rthumb[(f, tp)] = thumbs(os.path.join(rdir, f), transpose=tp)
    n_r = len(rthumb[(f, tps[0])])
    lo = max(0, r['_exp0'] - SEARCH); hi = min(s['frames'], r['_exp0'] + n_r + SEARCH)
    key = (r['path'], lo, hi)
    if key not in srccache: srccache[key] = thumbs(r['path'], lo, hi - lo, s['fps'])
    S = srccache[key]
    best = (-9, None, None)
    for tp in tps:
        R = rthumb[(f, tp)]
        for j0 in range(lo, max(lo, hi - len(R)) + 1):
            k = min(len(R), len(S) - (j0 - lo))
            if k < max(2, len(R) - 2): continue
            sc = float((R[:k] * S[j0 - lo:j0 - lo + k]).sum(1).mean())
            if sc > best[0]: best = (sc, j0, tp)
    scores[(f, rid)] = best
# assign: best pairs first, each render and row once
pairs = sorted(scores.items(), key=lambda kv: -kv[1][0])
used_f, used_r, out = set(), set(), []
for (f, rid), (sc, j0, tp) in pairs:
    if f in used_f or rid in used_r: continue
    used_f.add(f); used_r.add(rid)
    r = byrow[rid]; ri = rinfo[f]; s = srcinfo[r['path']]
    others = [v[0] for (ff, rr), v in scores.items() if ff == f and rr != rid]
    out.append({'id': rid, 'render': f, 'j0': j0, 'transpose': tp, 'exp0': r['_exp0'], 'score': round(sc, 4), 'next': round(max(others), 4) if others else None,
                'frames': ri['frames'], 'expn': r['_expn'], 'fps': ri['fps'], 'w': ri['w'], 'h': ri['h'], 'sar': ri['sar'], 'trc': ri['trc'],
                'tc': ri['tc'], 'src_tc': s['tc'], 'path': r['path'], 'name': r['name']})
miss_r = [r['id'] for r in rows if r['id'] not in used_r]
miss_f = [f for f in files if f not in used_f]
json.dump({'renders': rdir, 'handles': H, 'rows': out, 'missing_rows': miss_r, 'unused_renders': miss_f}, open(outp, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
weak = [o for o in out if o['score'] < 0.9]
off = [o for o in out if o['j0'] != o['exp0']]
print(f'matched {len(out)}/{len(rows)} rows; renders unused: {miss_f or "none"}; rows without a render: {miss_r or "none"}')
print(f'scores: min {min(o["score"] for o in out):.4f}, median {np.median([o["score"] for o in out]):.4f}; weak (<0.9): {[(o["id"], o["score"]) for o in weak] or "none"}')
print(f'renders starting off the expected frame: {[(o["id"], o["name"], o["j0"] - o["exp0"]) for o in off] or "none"}')
print('render formats:', sorted({(o['w'], o['h'], round(o['fps'], 3), o['sar'], o['trc']) for o in out}))
print('rotated renders (transpose that undoes them):', [(o['id'], o['name'], o['transpose']) for o in out if o['transpose']] or 'none')
