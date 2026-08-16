#!/usr/bin/env python3
"""Put the slide track, the deck text and the transcript side by side.

The slide track says WHAT is on screen; the transcript says what is being SAID.
Neither alone gives a cut plan: the deck skips (a lecturer talks over a slide
long after advancing it, or codes for half an hour with no slide at all) and
Whisper's timings drift by tens of seconds. Reading them together is the only
way to find the boundary the speaker actually crossed.

    python scripts/slidealign.py --track gen-out/slides/m5.json \
        --deck-json gen-out/slides/decks.json --module 5 \
        --tr gen-out/slides/tr5.json --out gen-out/slides/m5_align.md \
        [--min-run 8] [--chars 700]

Runs shorter than --min-run seconds are folded into the neighbouring run: a
one-second blip is a page turn caught mid-animation, not a block. Output is
markdown, meant to be READ, not parsed.
"""
import argparse
import io
import json
import sys


def load(p):
    return json.load(open(p, encoding='utf-8'))


def merge_runs(runs, min_run):
    """Drop sub-min_run runs, then join neighbours that ended up equal."""
    keep = [r for r in runs if r['t1'] - r['t0'] >= min_run]
    out = []
    for r in keep:
        if out and out[-1]['page'] == r['page']:
            out[-1]['t1'] = r['t1']
        else:
            out.append(dict(r))
    return out


def mmss(t):
    return f'{int(t) // 60}:{int(t) % 60:02d}'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--track', required=True)
    ap.add_argument('--deck-json', required=True)
    ap.add_argument('--module', required=True)
    ap.add_argument('--tr', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--min-run', type=float, default=8.0)
    ap.add_argument('--chars', type=int, default=700, help='transcript chars per run')
    a = ap.parse_args()
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

    track = load(a.track)
    deck = load(a.deck_json)[a.module]['pages']
    tr = load(a.tr)
    runs = merge_runs(track['runs'], a.min_run)

    titles = {p['n']: p['title'] for p in deck}
    segs = tr['segments']

    lines = [f'# module {a.module}: {len(runs)} runs, {len(deck)} slides, '
             f'{len(segs)} segments\n']
    si = 0
    for r in runs:
        t0, t1 = r['t0'], r['t1']
        pg = r['page']
        head = f"p{pg} — {titles.get(pg, '?')}" if pg else 'НЕТ СЛАЙДА'
        lines.append(f'\n## [{mmss(t0)}–{mmss(t1)}] {t1 - t0:.0f}s  {head}')
        while si < len(segs) and segs[si][1] <= t0:
            si += 1
        txt, j = [], si
        while j < len(segs) and segs[j][0] < t1:
            txt.append(segs[j][4])
            j += 1
        s = ' '.join(txt)
        if len(s) > a.chars:
            half = a.chars // 2
            s = s[:half] + '  …[' + str(len(s) - a.chars) + ' chars]…  ' + s[-half:]
        lines.append(s)

    open(a.out, 'w', encoding='utf-8').write('\n'.join(lines))
    print(f'{a.out}: {len(runs)} runs after merging <{a.min_run}s')


if __name__ == '__main__':
    main()
