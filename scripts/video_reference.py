#!/usr/bin/env python3
"""Measure hard-cut candidates and visible change in a flattened video. See references/video-reference.md."""
import argparse
import base64
import hashlib
import html
import io
import json
import math
import subprocess
import sys
import tempfile
from fractions import Fraction
from pathlib import Path
from statistics import median

import numpy as np
from PIL import Image


def probe(path):
    fields = ("stream=width,height,avg_frame_rate,time_base,start_pts,duration_ts:"
              "stream_side_data=rotation:frame=best_effort_timestamp,duration,pkt_duration")
    run = subprocess.run(["ffprobe", "-v", "error", "-protocol_whitelist", "file", "-select_streams",
                          "V:0", "-show_streams", "-show_frames", "-show_entries", fields,
                          "-of", "json", "-i", str(path)], capture_output=True, check=True)
    if run.stderr.strip():
        raise ValueError(run.stderr.decode(errors="replace"))
    info = json.loads(run.stdout)
    if not info.get("frames") or not info.get("streams"):
        raise ValueError("No decoded picture frames.")
    stream = info["streams"][0]
    frames = info["frames"]
    tick = Fraction(stream["time_base"])
    pts = [int(f["best_effort_timestamp"]) for f in frames]
    if any(b <= a for a, b in zip(pts, pts[1:])):
        raise ValueError("Frame presentation times are not strictly increasing.")
    frame_duration = int(frames[-1].get("duration") or frames[-1].get("pkt_duration") or 0)
    if frame_duration <= 0 and "duration_ts" in stream:
        frame_duration = int(stream.get("start_pts", pts[0])) + int(stream["duration_ts"]) - pts[-1]
    if frame_duration <= 0:
        raise ValueError("Last video frame has no usable end time.")
    edges = [(p - pts[0]) * tick for p in pts + [pts[-1] + frame_duration]]
    rate = Fraction(len(frames), 1) / edges[-1]
    if stream.get("avg_frame_rate") not in (None, "0/0", "0/1"):
        rate = Fraction(stream["avg_frame_rate"])
    w, h = stream["width"], stream["height"]
    rotation = next((float(s["rotation"]) for s in stream.get("side_data_list", [])
                     if "rotation" in s), 0)
    if abs(rotation - round(rotation / 90) * 90) > 0.01:
        raise ValueError("Arbitrary display rotation is unsupported. Supply an upright export.")
    if round(rotation / 90) % 2:
        w, h = h, w
    regular = all(abs(t - Fraction(i, 1) / rate) <= tick for i, t in enumerate(edges))
    return {"width": w, "height": h, "fps": str(rate), "on_average_rate_grid": regular,
            "frames": len(frames), "seconds": float(edges[-1]), "time_base": str(tick)}, edges


def area_box(value):
    name, sep, coords = value.partition("=")
    if not sep or not name.strip() or name.strip() == "frame":
        raise argparse.ArgumentTypeError("ROI must be name=x,y,width,height; frame is reserved")
    try:
        x, y, w, h = map(int, coords.split(","))
    except ValueError as e:
        raise argparse.ArgumentTypeError("Expected four integer ROI coordinates") from e
    if min(x, y) < 0 or min(w, h) <= 0:
        raise argparse.ArgumentTypeError("ROI must have a positive size and nonnegative origin")
    return name.strip(), (x, y, w, h)


def proxy_box(box, width, height, pw, ph):
    x, y, w, h = box
    if x + w > width or y + h > height:
        raise ValueError(f"ROI {box} exceeds the {width}x{height} picture")
    return (x * pw // width, y * ph // height,
            math.ceil((x + w) * pw / width), math.ceil((y + h) * ph / height))


def proxy_frames(path, width, height, selected=None, *, region=None, frame_range=None):
    filters = []
    if frame_range is not None:
        if selected is not None:
            raise ValueError("Choose a frame range or individual frames")
        start, end = frame_range
        filters.append(f"trim=start_frame={start}:end_frame={end}")
    if selected is not None:
        expr = "+".join(f"eq(n,{i})" for i in selected)
        filters.append(f"select='{expr}'")
    if region is not None:
        x, y, w, h = region
        filters.append(f"crop=w={w}:h={h}:x={x}:y={y}:exact=1")
    filters.extend([f"scale={width}:{height}:flags=area", "format=rgb24"])
    cmd = ["ffmpeg", "-nostdin", "-v", "error", "-xerror", "-protocol_whitelist", "file",
           "-i", str(path), "-map", "0:V:0", "-an", "-sn", "-dn", "-vf", ",".join(filters)]
    if selected is not None:
        cmd.extend(["-frames:v", str(len(selected))])
    elif frame_range is not None:
        cmd.extend(["-frames:v", str(end - start)])
    cmd.extend(["-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"])
    size = width * height * 3
    with tempfile.TemporaryFile() as log, subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=log) as proc:
        try:
            while True:
                data = proc.stdout.read(size)
                if not data:
                    break
                if len(data) != size:
                    raise ValueError("Incomplete decoded proxy frame")
                yield np.frombuffer(data, np.uint8).reshape(height, width, 3)
            if proc.wait():
                log.seek(0)
                raise ValueError(f"ffmpeg: {log.read().decode(errors='replace')[-1000:]}")
        finally:
            proc.stdout.close()
            if proc.poll() is None:
                proc.kill()


def measure(path, pw, ph, boxes):
    tracks = {name: [] for name in ["frame", *boxes]}
    prev = None
    for rgb in proxy_frames(path, pw, ph):
        frame = rgb.astype(np.int16)
        if prev is None:
            for values in tracks.values():
                values.append(0.0)
        else:
            diff = np.abs(frame - prev)
            tracks["frame"].append(float(diff.mean()))
            for name, (x0, y0, x1, y1) in boxes.items():
                tracks[name].append(float(diff[y0:y1, x0:x1].mean()))
        prev = frame
    return tracks


def cut_candidates(scores, threshold):
    """Abrupt whole-picture difference above local motion; percentage of full RGB scale."""
    cuts = []
    for i in range(1, len(scores)):
        neighbors = scores[max(1, i-3):i] + scores[i+1:i+4]
        base = median(neighbors) if len(neighbors) >= 3 else 0
        prominence = (scores[i] - base) * 100 / 255
        if prominence >= threshold:
            cuts.append({"frame": i, "score_percent": round(prominence, 3)})
    return cuts


def intervals(values, start, end, edges, threshold):
    result = []
    a = start
    while a < end:
        if a == start:
            state, b = "baseline", a + 1
        else:
            active = values[a] >= threshold
            state = "change" if active else "low_change"
            b = a + 1
            while b < end and (values[b] >= threshold) == active:
                b += 1
        peak = max(range(a, b), key=values.__getitem__)
        result.append({"state": state, "in": a, "out": b,
                       "t_in": float(edges[a]), "t_out": float(edges[b]),
                       "shot_t_in": float(edges[a]-edges[start]), "shot_t_out": float(edges[b]-edges[start]),
                       "peak_frame": peak if state != "baseline" else None,
                       "peak_rgb_delta": round(values[peak], 3) if state != "baseline" else None})
        a = b
    return result


def evenly(items, cap):
    if cap <= 0:
        return []
    if len(items) <= cap:
        return items
    if cap == 1:
        return [items[len(items)//2]]
    return [items[round(i * (len(items)-1)/(cap-1))] for i in range(cap)]


def preview_groups(cuts, shots, regions, selected, cap):
    groups = [("Начало видео", "frame", [0])]
    for c in evenly(cuts, cap):
        n = c["frame"]
        groups.append(("Кандидат в склейку", "frame", [n-1, n]))
    for name in regions:
        changes = [e for s in shots for e in s["regions"][name] if e["state"] == "change"]
        for e in evenly(changes, cap):
            frames = [e["in"]-1, e["peak_frame"], e["out"]-1]
            groups.append(("Изменение", name, sorted(set(frames))))
    for n in selected:
        for name in regions:
            groups.append(("Контрольный кадр", name, [n]))
    return groups


def thumbnails(path, pw, ph, boxes, groups):
    needed = {}
    for _, name, indices in groups:
        for i in indices:
            needed.setdefault(i, set()).add(name)
    keys = sorted(needed)
    images = {}
    for i, rgb in zip(keys, proxy_frames(path, pw, ph, keys), strict=True):
        full = Image.fromarray(rgb)
        for name in needed[i]:
            pic = full.copy() if name == "frame" else full.crop(boxes[name])
            pic.thumbnail((300, 180), Image.Resampling.LANCZOS)
            buf = io.BytesIO()
            pic.save(buf, format="JPEG", quality=88)
            images[(i, name)] = base64.b64encode(buf.getvalue()).decode("ascii")
    return images


def report_html(data, filename, groups, images):
    esc = html.escape
    def figure(i, name):
        payload = images[(i, name)]
        return (f'<figure><img alt="f{i}" src="data:image/jpeg;base64,{payload}">'
                f'<figcaption>f{i}</figcaption></figure>')
    def row(event):
        label = {"baseline":"Опорный кадр", "change":"Изменение", "low_change":"Ниже порога"}[event["state"]]
        return (f'<tr><td>{label}</td><td>[{event["in"]}, {event["out"]})</td>'
                f'<td>{event["t_in"]:.3f}–{event["t_out"]:.3f}</td>'
                f'<td>{event["shot_t_in"]:.3f}–{event["shot_t_out"]:.3f}</td>'
                f'<td>{event["peak_rgb_delta"] if event["peak_rgb_delta"] is not None else "—"}</td></tr>')
    meta = data["video"]
    chunks = ['<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Разбор референса</title>',
              '<style>body{font:16px/1.45 system-ui,sans-serif;max-width:1000px;margin:2em auto;padding:0 1em;color:#181b20}table{border-collapse:collapse}td,th{padding:.2em .65em;border-bottom:1px solid #ddd;text-align:left}summary{cursor:pointer}figure{display:inline-block;margin:.4em;vertical-align:top}figcaption{font-size:.8em}img{max-width:100%}</style>',
              f'<h1>{esc(Path(data["source"]).name)}</h1>',
              f'<p>{meta["width"]} × {meta["height"]}, {meta["fps"]} fps (средняя), {meta["frames"]} кадров, {meta["seconds"]:.3f} с. '
              f'<a href="{filename}">JSON</a></p>',
              f'<p>Кандидатов в склейки: {len(data["cuts"])}. Первый кадр каждого плана служит точкой отсчёта. '
              'Интервалы [in, out) даны в кадрах показа. Изменение — разница соседних кадров выше порога в выбранной области. '
              'Вспышка или резкое движение камеры также могут выглядеть как склейка.</p>',
              '<h2>Границы</h2>',
              '<p>' + (', '.join(f'f{c["frame"]} ({c["seconds"]:.3f} с)' for c in data["cuts"]) or 'Кандидаты не обнаружены.') + '</p>',
              '<h2>Внутри планов</h2>']
    for shot in data["shots"]:
        chunks.append(f'<h3>План {shot["shot"]} · [{shot["in"]}, {shot["out"]})</h3>')
        for name, events in shot["regions"].items():
            changes = sum(e["state"]=="change" for e in events)
            box = data["regions"][name]
            chunks.append(f'<details><summary>{esc(name)} · {changes} интервалов изменения · x/y/w/h {esc(str(box))}</summary>'
                          '<table><tr><th>Наблюдение</th><th>Кадры</th><th>От видео, с</th><th>От плана, с</th><th>Пик RGB</th></tr>'
                          + ''.join(row(e) for e in events) + '</table></details>')
    chunks.append('<h2>Кадры для просмотра</h2>')
    for title, name, indices in groups:
        chunks.append(f'<p><strong>{title} · {esc(name)}</strong><br>' + ''.join(figure(i,name) for i in indices) + '</p>')
    return '\n'.join(chunks) + '</html>\n'


def atomic_file(path, content):
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as f:
        tmp = Path(f.name)
        try:
            f.write(content)
        except BaseException:
            f.close()
            tmp.unlink(missing_ok=True)
            raise
    try:
        tmp.replace(path)
    finally:
        tmp.unlink(missing_ok=True)


def main(args):
    path = args.video.resolve()
    if not path.is_file():
        raise ValueError(f"Missing video: {path}")
    regions = dict(args.roi)
    if len(regions) != len(args.roi):
        raise ValueError("ROI names must be unique")
    if not (0 < args.cut_threshold <= 100 and 0 < args.activity_threshold <= 255):
        raise ValueError("Cut threshold must be in (0,100], activity threshold in (0,255]")
    if not 16 <= args.proxy <= 1920 or not 0 <= args.previews <= 50:
        raise ValueError("Proxy edge must be 16–1920 px; previews 0–50 per track")
    before = path.stat()
    meta, edges = probe(path)
    width, height = meta["width"], meta["height"]
    if any(i < 0 or i >= meta["frames"] for i in args.at_frame):
        raise ValueError("Control frame is outside the decoded video")
    scale = min(1, args.proxy / max(width, height))
    pw, ph = max(1, round(width*scale)), max(1, round(height*scale))
    boxes = {name: proxy_box(box, width, height, pw, ph) for name, box in regions.items()}
    tracks = measure(path, pw, ph, boxes)
    if len(tracks["frame"]) != meta["frames"]:
        raise ValueError("Frame count differs between timestamp probe and RGB decode")
    cuts = cut_candidates(tracks["frame"], args.cut_threshold)
    for c in cuts:
        c["seconds"] = float(edges[c["frame"]])
    bounds = [0, *(c["frame"] for c in cuts), meta["frames"]]
    shots = []
    for n, (a,b) in enumerate(zip(bounds, bounds[1:]), 1):
        shots.append({"shot": n, "in": a, "out": b, "t_in": float(edges[a]), "t_out": float(edges[b]),
                      "regions": {name: intervals(values, a, b, edges, args.activity_threshold)
                                  for name, values in tracks.items()}})
    data = {"version":1, "source":str(path), "source_bytes":before.st_size, "source_mtime_ns":before.st_mtime_ns,
            "video":meta, "proxy":[pw,ph], "thresholds":{"cut_percent":args.cut_threshold,
            "activity_mean_rgb":args.activity_threshold}, "regions":{"frame":[0,0,width,height],**regions},
            "cuts":cuts, "shots":shots}
    groups = preview_groups(cuts, shots, data["regions"], sorted(set(args.at_frame)), args.previews)
    images = thumbnails(path, pw, ph, boxes, groups)
    after = path.stat()
    if (before.st_size,before.st_mtime_ns) != (after.st_size,after.st_mtime_ns):
        raise ValueError("The source changed during analysis")
    payload = (json.dumps(data, ensure_ascii=False, indent=2, allow_nan=False) + "\n").encode("utf-8")
    filename = f"reference-{hashlib.sha256(payload).hexdigest()[:16]}.json"
    page = report_html(data, filename, groups, images).encode("utf-8")
    args.out.mkdir(parents=True, exist_ok=True)
    atomic_file(args.out / filename, payload)
    atomic_file(args.out / "report.html", page)
    print(json.dumps({"report":str(args.out/"report.html"),"json":str(args.out/filename),
                      "frames":meta["frames"],"cut_candidates":len(cuts)}, ensure_ascii=True))


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("video", type=Path)
    p.add_argument("--out", type=Path, required=True)
    p.add_argument("--roi", type=area_box, action="append", default=[], metavar="NAME=X,Y,W,H")
    p.add_argument("--at-frame", type=int, action="append", default=[], help="show this decoded frame in every region")
    p.add_argument("--cut-threshold", type=float, default=10.0, help="whole-frame change prominence, percent")
    p.add_argument("--activity-threshold", type=float, default=2.0, help="mean adjacent RGB change, levels (0–255)")
    p.add_argument("--proxy", type=int, default=480, help="analysis longest edge in pixels (default 480)")
    p.add_argument("--previews", type=int, default=10, help="evenly sample up to N cuts and changes per region for review")
    try:
        main(p.parse_args())
    except (OSError, ValueError, KeyError, subprocess.CalledProcessError) as exc:
        detail = getattr(exc, "stderr", None)
        message = detail.decode(errors="replace")[-1000:] if detail else str(exc)
        sys.exit(f"video_reference: {message}")
