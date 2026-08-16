#!/usr/bin/env python3
"""Emit slidetrack views for a deck shown in a scrolling PDF viewer.

    python scripts/scrollviews.py --w 1850 --x 35 --top 56 --bottom 1053

macOS Preview in continuous-scroll mode does not put a page turn back at the
same place: after every turn the page sits a few dozen pixels higher or lower,
and a single view built from one calibration frame matches only the slides that
happen to share that offset. Module 7 scored 11% and module 8 22% for exactly
this reason, while the same frames matched at 0.97 once the offset was right.

So sweep the offset instead of guessing it. The page is always the same width
(--w) at the same left edge (--x); only the top edge Y moves. For every Y this
prints the frame rectangle actually covered by the page and the part of the page
it shows.

Offsets that keep the page over the whole visible band share ONE frame
rectangle and cost a single decode in slidetrack; the others are quantised to
--coarse so a wide sweep still fits in a handful of decodes.
"""
import argparse

PW, PH_PAGE = 960.0, 540.0

p = argparse.ArgumentParser()
p.add_argument('--w', type=int, default=1850, help='page width in the frame')
p.add_argument('--x', type=int, default=35, help='page left edge in the frame')
p.add_argument('--top', type=int, default=56, help='first frame row below the viewer toolbar')
p.add_argument('--bottom', type=int, default=1053, help='first frame row of the bottom overlay')
p.add_argument('--range', default='-60:120', help='sweep of the page top edge Y')
p.add_argument('--fine', type=int, default=4, help='Y step while the page covers the band')
p.add_argument('--coarse', type=int, default=20, help='Y step outside that, one decode each')
a = p.parse_args()

H = a.w * PH_PAGE / PW                      # page height in frame pixels
lo, hi = (int(v) for v in a.range.split(':'))

# The band is fully covered when the page starts above its bottom and ends below
# its top -- there the frame rectangle is constant and extra offsets are free.
full_lo, full_hi = a.bottom - H, a.top

seen, out = set(), []
for y in range(lo, hi + 1):
    step = a.fine if full_lo - 1 <= y <= full_hi + 1 else a.coarse
    if (y - lo) % step:
        continue
    y0, y1 = max(a.top, y), min(a.bottom, int(round(y + H)))
    if y1 - y0 < 400:
        continue
    py = (y0 - y) / H * PH_PAGE
    ph = min((y1 - y0) / H * PH_PAGE, PH_PAGE - py)
    if ph < 200:
        continue
    v = f'{a.w}:{y1 - y0}:{a.x}:{y0}@{PW:.0f}:{ph:.1f}:0:{py:.1f}'
    if v not in seen:
        seen.add(v)
        out.append(v)

print(','.join(out))
