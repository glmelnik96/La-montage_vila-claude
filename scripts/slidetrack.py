#!/usr/bin/env python3
"""Which slide is on screen, second by second.

For a screen-shared lecture the deck is the ground truth for structure -- far
better than a transcript, whose timings drift. This renders every page of the
PDF, samples the video on a fixed grid, and picks the best-matching page per
sample by normalised cross-correlation.

    python scripts/slidetrack.py calibrate --deck D.pdf --src V.mp4 [--at 1500,3000]
    python scripts/slidetrack.py track --deck D.pdf --src V.mp4 --out t.json \
        --views "1784:1003:68:39@0:0:960:540" [--fps 2] [--min-corr 0.5]

A VIEW says "this rectangle of the video frame shows that rectangle of the deck
page": `fw:fh:fx:fy@pw:ph:px:py`, page coordinates in a 960x540 space. Several
views may be given; the best correlation wins per sample.

Four things that each cost a full run when got wrong:

* Do NOT infer slide boundaries from the sequence's scene-detect cuts. Scene
  detection fires on animation and camera moves and misses visually similar
  consecutive slides -- neither sound nor complete. Scanning a whole 2-hour
  module costs about a minute, so there is nothing to save.
* A screen share is never full-frame. Correlating the whole 1920x1080 frame
  against the deck matched 0% here.
* There is no single geometry per module. A lecturer alternates between the deck
  and a browser or IDE, and may show the deck in a PDF viewer rather than
  full-screen -- in which case a toolbar clips the top of the page and only PART
  of the page is visible. That is why a view carries a page rectangle too;
  matching a clipped page against the whole page scored 0.45 where the correct
  sub-rectangle scored 0.85.
* Downsample by AREA, never by picking pixels. Nearest-neighbour decimation of
  1780px-wide slides to 256px destroys the text strokes the match depends on and
  silently halves every score. ffmpeg's scale filter does the right thing.

Output: {"samples":[[t, page|null, corr, margin], ...], "runs":[{page,t0,t1,n}, ...]}
`page` is 1-based and matches the PDF page number.

Requires PyMuPDF + numpy + Pillow + ffmpeg.
"""
import argparse
import io
import json
import subprocess
import sys

import fitz
import numpy as np
from PIL import Image

CW, CH = 256, 144          # comparison size
PW, PH = 960, 540          # page coordinate space
SRCW, SRCH = 1920, 1080


def norm(a):
    a = a.astype(np.float32)
    a -= a.mean(axis=-1, keepdims=True)
    n = np.linalg.norm(a, axis=-1, keepdims=True)
    return a / np.maximum(n, 1e-6)


def render_pages(pdf, scale=2):
    doc = fitz.open(pdf)
    out = []
    for pg in doc:
        r = pg.rect
        pm = pg.get_pixmap(matrix=fitz.Matrix(PW * scale / r.width, PH * scale / r.height),
                           colorspace=fitz.csGRAY)
        out.append(Image.frombytes('L', (pm.width, pm.height), pm.samples))
    return out


def parse_view(s):
    f, p = s.split('@')
    fw, fh, fx, fy = (int(v) for v in f.split(':'))
    pw, ph, px, py = (float(v) for v in p.split(':'))
    return (fw, fh, fx, fy), (pw, ph, px, py)


def templates(pages, prect, scale=2):
    pw, ph, px, py = prect
    box = (px * scale, py * scale, (px + pw) * scale, (py + ph) * scale)
    return norm(np.stack([np.asarray(p.resize((CW, CH), Image.BOX, box=box)).ravel()
                          for p in pages]))


def frames(src, fps, frect):
    fw, fh, fx, fy = frect
    p = subprocess.Popen(
        ['ffmpeg', '-v', 'error', '-i', src, '-vf',
         f'crop={fw}:{fh}:{fx}:{fy},fps={fps},scale={CW}:{CH}',
         '-pix_fmt', 'gray', '-f', 'rawvideo', '-'],
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    size, chunk = CW * CH, 512
    while True:
        buf = p.stdout.read(size * chunk)
        if not buf:
            break
        n = len(buf) // size
        yield np.frombuffer(buf[:n * size], dtype=np.uint8).reshape(n, size)
        if n < chunk:
            break
    p.stdout.close()
    p.wait()


def grab(src, t):
    o = subprocess.run(['ffmpeg', '-v', 'error', '-ss', f'{t:.2f}', '-i', src, '-frames:v', '1',
                        '-pix_fmt', 'gray', '-f', 'rawvideo', '-'], capture_output=True).stdout
    if len(o) < SRCW * SRCH:
        return None
    return Image.frombytes('L', (SRCW, SRCH), o[:SRCW * SRCH])


def cmd_calibrate(a):
    """Grid-search where the deck page sits in the frame, by correlation.

    Reports the winning view for each probe time. Times showing a notebook or a
    camera legitimately score low -- look for a geometry that repeats.
    """
    pages = render_pages(a.deck)
    dur = float(subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration',
                                '-of', 'csv=p=0', a.src], capture_output=True,
                               text=True).stdout.strip())
    times = [float(x) for x in a.at.split(',')] if a.at else \
        [dur * k / 13 for k in range(1, 13)]

    cache = {}
    for t in times:
        img = grab(a.src, t)
        if img is None:
            continue
        best = (-1,)
        for w in range(1500, 1961, 20):
            h = round(w * PH / PW)
            for x in range(-60, 201, 20):
                for y in range(-160, 161, 20):
                    fx0, fy0 = max(0, x), max(0, y)
                    fx1, fy1 = min(SRCW, x + w), min(SRCH, y + h)
                    if fx1 - fx0 < 600 or fy1 - fy0 < 400:
                        continue
                    prect = ((fx1 - fx0) / w * PW, (fy1 - fy0) / h * PH,
                             (fx0 - x) / w * PW, (fy0 - y) / h * PH)
                    key = tuple(round(v, 1) for v in prect)
                    if key not in cache:
                        cache[key] = templates(pages, prect)
                    v = norm(np.asarray(img.resize((CW, CH), Image.BOX,
                                                   box=(fx0, fy0, fx1, fy1))).ravel())
                    c = cache[key] @ v
                    i = int(c.argmax())
                    if c[i] > best[0]:
                        best = (float(c[i]), i + 1, fx1 - fx0, fy1 - fy0, fx0, fy0, prect)
        c, pg, fw, fh, fx, fy, pr = best
        print(f't={t:7.1f}  p{pg:<3} corr={c:.3f}  '
              f'--views "{fw}:{fh}:{fx}:{fy}@'
              f'{pr[0]:.1f}:{pr[1]:.1f}:{pr[2]:.1f}:{pr[3]:.1f}"')


def cmd_track(a):
    pages = render_pages(a.deck)
    views = [parse_view(v) for v in a.views.split(',')]

    # A PDF viewer in continuous-scroll mode leaves the page at a different
    # vertical offset after every page turn, so covering a module takes a dozen
    # views that differ ONLY in the page rectangle. Decoding once per view would
    # re-read the whole file a dozen times; group by frame rectangle so each
    # distinct crop is decoded once and correlated against every page rectangle
    # that shares it.
    by_frect = {}
    for frect, prect in views:
        by_frect.setdefault(frect, []).append(prect)

    per_view = []
    for frect, prects in by_frect.items():
        tpls = [templates(pages, p).T for p in prects]
        cols = [[] for _ in prects]
        for block in frames(a.src, a.fps, frect):
            v = norm(block.astype(np.float32))
            for j, tpl in enumerate(tpls):
                cols[j].append(v @ tpl)
        for c in cols:
            per_view.append(np.concatenate(c) if c else np.zeros((0, len(pages))))

    n = min(len(c) for c in per_view)
    best_c = per_view[0][:n].copy()
    for c in per_view[1:]:
        np.maximum(best_c, c[:n], out=best_c)

    rows = np.arange(n)
    top_i = best_c.argmax(axis=1)
    top = best_c[rows, top_i].copy()
    best_c[rows, top_i] = -2
    second = best_c.max(axis=1)

    samples = []
    for k in range(n):
        t = round(k / a.fps, 3)
        if top[k] < a.min_corr:
            samples.append([t, None, round(float(top[k]), 4), 0.0])
        else:
            samples.append([t, int(top_i[k]) + 1, round(float(top[k]), 4),
                            round(float(top[k] - second[k]), 4)])

    runs = []
    for t, pg, _, _ in samples:
        if runs and runs[-1]['page'] == pg:
            runs[-1]['t1'] = t
            runs[-1]['n'] += 1
        else:
            runs.append({'page': pg, 't0': t, 't1': t, 'n': 1})

    with open(a.out, 'w', encoding='utf-8') as f:
        json.dump({'fps': a.fps, 'views': a.views, 'pages': len(pages),
                   'samples': samples, 'runs': runs}, f)
    named = sum(1 for s in samples if s[1] is not None)
    print(f'{a.out}: {n} samples, {named} matched ({100 * named / n:.1f}%), '
          f'{len(runs)} runs, {len(pages)} pages')


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest='cmd', required=True)
    c = sub.add_parser('calibrate')
    c.add_argument('--deck', required=True)
    c.add_argument('--src', required=True)
    c.add_argument('--at', help='comma-separated seconds; default 12 spread over the file')
    t = sub.add_parser('track')
    t.add_argument('--deck', required=True)
    t.add_argument('--src', required=True)
    t.add_argument('--out', required=True)
    t.add_argument('--views', required=True)
    t.add_argument('--fps', type=float, default=2.0)
    t.add_argument('--min-corr', type=float, default=0.5)
    a = ap.parse_args()
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
    (cmd_calibrate if a.cmd == 'calibrate' else cmd_track)(a)


if __name__ == '__main__':
    main()
