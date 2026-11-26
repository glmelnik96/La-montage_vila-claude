"""Locate changes of a coloured caption highlight in a selected part of a local export.

Usage and limits: references/caption-highlights.md. All boxes use displayed source px.
"""
import argparse
import json
import subprocess
import sys
from pathlib import Path

import numpy as np

from video_reference import atomic_file, probe, proxy_frames


def highlight_box(rgb, color, tolerance, min_pixels):
    low = np.maximum(0, color - tolerance)
    high = np.minimum(255, color + tolerance)
    mask = np.all((rgb >= low) & (rgb <= high), axis=2)
    if np.count_nonzero(mask) < min_pixels:
        return None
    # Ignore isolated near-colour pixels outside a bar, e.g. codec speckles.
    col_counts = mask.sum(axis=0)
    row_counts = mask.sum(axis=1)
    xs = np.flatnonzero(col_counts >= max(1, col_counts.max() * 0.12))
    ys = np.flatnonzero(row_counts >= max(1, row_counts.max() * 0.12))
    return int(xs[0]), int(ys[0]), int(xs[-1] + 1), int(ys[-1] + 1)


def measure_highlights(images, first, edges, roi, color, tolerance, min_pixels, jitter):
    x, y, _, _ = roi
    events = []
    anchor = None
    last_end = first
    for f, rgb in enumerate(images, first):
        box = highlight_box(rgb, color, tolerance, min_pixels)
        last_end = f + 1
        if box is None:
            anchor = None
            continue
        if anchor is None or max(abs(a-b) for a, b in zip(anchor, box)) > jitter:
            anchor = box
            left, top, right, bottom = box
            events.append({"in": f, "out": f+1, "box": [x+left, y+top, right-left, bottom-top]})
        else:
            events[-1]["out"] = f+1
    for event in events:
        event["startSec"] = float(edges[event["in"]])
        event["endSec"] = float(edges[event["out"]])
    return events, last_end


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("media", type=Path)
    parser.add_argument("--box", nargs=4, type=int, metavar=("X","Y","W","H"), required=True)
    parser.add_argument("--rgb", nargs=3, type=int, metavar=("R","G","B"), required=True)
    parser.add_argument("--frames", nargs=2, type=int, metavar=("IN","OUT"))
    parser.add_argument("--tolerance", type=int, default=28, help="maximum distance per RGB channel")
    parser.add_argument("--min-pixels", type=int, default=24, help="minimum matching pixels inside the ROI")
    parser.add_argument("--jitter", type=int, default=6, help="allowed displacement of each box edge in pixels")
    parser.add_argument("--out", type=Path, required=True, help="output JSON file")
    args = parser.parse_args()
    src = args.media.resolve(strict=True)
    if args.out.resolve() == src:
        parser.error("Choose a JSON output separate from the source video")
    meta, edges = probe(src)
    x, y, w, h = args.box
    if min(x, y) < 0 or min(w, h) <= 0 or x+w > meta["width"] or y+h > meta["height"]:
        parser.error("--box must be within the displayed image")
    if min(args.rgb) < 0 or max(args.rgb) > 255 or not 0 <= args.tolerance < 255:
        parser.error("Invalid RGB colour or tolerance")
    if not 0 < args.min_pixels <= w*h or args.jitter < 0:
        parser.error("Invalid minimum pixel count or jitter")
    first, end = args.frames or (0, meta["frames"])
    if not 0 <= first < end <= meta["frames"]:
        parser.error("--frames must be a nonempty interval of source frames")
    images = proxy_frames(src, w, h, region=args.box, frame_range=(first, end))
    events, decoded_end = measure_highlights(images, first, edges, args.box, np.array(args.rgb),
                                             args.tolerance, args.min_pixels, args.jitter)
    if decoded_end != end:
        raise ValueError("Decoded range and source frame clock disagree")
    evidence = {"source": str(src), "displaySize": [meta["width"], meta["height"]],
                "scope": [first, end], "roi": args.box, "rgb": args.rgb, "tolerance": args.tolerance,
                "minPixels": args.min_pixels, "jitterPx": args.jitter, "highlights": events}
    args.out.parent.mkdir(parents=True, exist_ok=True)
    atomic_file(args.out, (json.dumps(evidence, ensure_ascii=False, indent=2)+"\n").encode("utf-8"))
    print(f"{len(events)} highlight intervals on source frames [{first}, {end})")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, subprocess.CalledProcessError) as exc:
        sys.exit(f"caption_highlights: {exc}")
