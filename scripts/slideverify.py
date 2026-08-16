#!/usr/bin/env python3
"""Look at what slidetrack decided.

Builds a sheet of video-frame / deck-page pairs, one per run, so the match can be
checked by eye. A correlation score says the numbers agreed; only the picture
shows that the right slide was picked.

    python scripts/slideverify.py --track gen-out/slides/m5.json \
        --deck <deck.pdf> --src <video.mp4> --out gen-out/slides/m5_check.png \
        [--every 1] [--cols 4]

Each pair is captioned `<run index> t=<mid> p<page> c<corr>`; the video frame is
on the left, the deck page on the right. They should be the same slide.
"""
import argparse
import io
import json
import subprocess
import sys

import fitz
import numpy as np
from PIL import Image, ImageDraw

CW, CH = 320, 180


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--track', required=True)
    ap.add_argument('--deck', required=True)
    ap.add_argument('--src', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--every', type=int, default=1, help='sample every Nth run')
    ap.add_argument('--cols', type=int, default=4)
    ap.add_argument('--min-dur', type=float, default=0.0)
    a = ap.parse_args()
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

    tr = json.load(open(a.track, encoding='utf-8'))
    doc = fitz.open(a.deck)
    runs = [(i, r) for i, r in enumerate(tr['runs'])
            if r['page'] is not None and r['t1'] - r['t0'] >= a.min_dur][::a.every]

    cell_w, cell_h = CW * 2 + 12, CH + 20
    cols = a.cols
    rows = (len(runs) + cols - 1) // cols
    sheet = Image.new('RGB', (cols * cell_w + 8, rows * cell_h + 8), (24, 24, 24))
    d = ImageDraw.Draw(sheet)

    for k, (idx, r) in enumerate(runs):
        t = (r['t0'] + r['t1']) / 2
        o = subprocess.run(['ffmpeg', '-v', 'error', '-ss', f'{t:.2f}', '-i', a.src,
                            '-frames:v', '1', '-vf', f'scale={CW}:{CH}', '-pix_fmt', 'rgb24',
                            '-f', 'rawvideo', '-'], capture_output=True).stdout
        frame = Image.frombytes('RGB', (CW, CH), o[:CW * CH * 3]) if len(o) >= CW * CH * 3 \
            else Image.new('RGB', (CW, CH), (80, 0, 0))

        pg = doc[r['page'] - 1]
        rect = pg.rect
        pm = pg.get_pixmap(matrix=fitz.Matrix(CW / rect.width, CH / rect.height))
        page = Image.frombytes('RGB', (pm.width, pm.height), pm.samples).resize((CW, CH))

        x = 4 + (k % cols) * cell_w
        y = 4 + (k // cols) * cell_h
        sheet.paste(frame, (x, y + 18))
        sheet.paste(page, (x + CW + 8, y + 18))
        d.text((x + 2, y + 4), f"#{idx} t={t:.0f}s  p{r['page']}  "
                               f"{r['t1'] - r['t0']:.0f}s", fill=(230, 230, 230))

    sheet.save(a.out)
    print(f'{a.out}: {len(runs)} runs (video | deck). READ this image.')


if __name__ == '__main__':
    main()
