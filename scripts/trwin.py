#!/usr/bin/env python3
"""Print the transcript around a time, one paragraph per line.

    python scripts/trwin.py --tr gen-out/slides/tr7.json --from 6800 --to 7260

The slide track can only say "no slide here". Where the lecturer works in a
notebook for twenty minutes, the boundary between two blocks exists only in what
is being SAID -- "идемте дальше", "переходим к", "давайте откроем". This dumps
the window so those sentences can be found and the time read off directly.
"""
import argparse
import json

p = argparse.ArgumentParser()
p.add_argument('--tr', required=True)
p.add_argument('--from', dest='t0', type=float, default=0)
p.add_argument('--to', dest='t1', type=float, default=1e9)
p.add_argument('--grep', help='only paragraphs containing this substring (case-insensitive)')
a = p.parse_args()

d = json.load(open(a.tr, encoding='utf-8'))
for s, e, text in d['paragraphs']:
    if e < a.t0 or s > a.t1:
        continue
    if a.grep and a.grep.lower() not in text.lower():
        continue
    print(f'{s:8.1f}-{e:8.1f}  {text}')
