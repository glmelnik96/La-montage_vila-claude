#!/usr/bin/env python3
"""Look at the first frame of every block in a cut plan.

    python scripts/planverify.py --plan gen-out/slides/m7_plan.json \
        --out gen-out/slides/m7_plan_check.png [--at 3] [--cols 4]

slideverify.py checks the slide TRACK -- did correlation pick the right page.
This checks the PLAN -- does each block actually START on the slide it is named
after. Those are different questions: a block boundary comes from the transcript
as often as from the track, and a boundary that is ten seconds early leaves the
previous slide on screen for the whole opening of the sequence.

Each cell is captioned `<n> t=<start> p<page>` with the video frame on the left
and the deck page the block claims on the right. Blocks whose page was never
detected (marked СПОРНО in the plan) are exactly the ones to look at hardest.

`--at` is how many seconds past the boundary to grab: a second or two of margin
avoids catching the page turn itself.
"""
import argparse
import json
import subprocess

import fitz
from PIL import Image, ImageDraw

CW, CH = 320, 180
SRCW, SRCH = 1920, 1080


def grab(src, t):
    o = subprocess.run(['ffmpeg', '-v', 'error', '-ss', f'{t:.2f}', '-i', src, '-frames:v', '1',
                        '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-'], capture_output=True).stdout
    if len(o) < SRCW * SRCH * 3:
        return Image.new('RGB', (CW, CH))
    return Image.frombytes('RGB', (SRCW, SRCH), o[:SRCW * SRCH * 3]).resize((CW, CH), Image.BOX)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--plan', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--at', type=float, default=3.0)
    ap.add_argument('--cols', type=int, default=4)
    a = ap.parse_args()

    plan = json.load(open(a.plan, encoding='utf-8'))
    doc = fitz.open(plan['deck'])

    cells = []
    for b in plan['blocks']:
        t = b['keep'][0][0] + a.at
        pg = b['pages'][0]
        pm = doc[pg - 1].get_pixmap(matrix=fitz.Matrix(CW / doc[pg - 1].rect.width,
                                                       CH / doc[pg - 1].rect.height))
        page = Image.frombytes('RGB', (pm.width, pm.height), pm.samples)
        cells.append((f"{b['n']} t={b['keep'][0][0]:.0f} p{pg}", grab(plan['src'], t), page))

    cw, ch = CW * 2 + 12, CH + 20
    rows = (len(cells) + a.cols - 1) // a.cols
    sheet = Image.new('RGB', (cw * a.cols, ch * rows), 'white')
    d = ImageDraw.Draw(sheet)
    for i, (cap, vid, page) in enumerate(cells):
        x, y = (i % a.cols) * cw, (i // a.cols) * ch
        d.text((x + 2, y + 4), cap, fill='black')
        sheet.paste(vid, (x, y + 18))
        sheet.paste(page, (x + CW + 8, y + 18))
    sheet.save(a.out)
    print(f'{a.out}: {len(cells)} blocks')


if __name__ == '__main__':
    main()
