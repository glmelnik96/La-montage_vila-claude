#!/usr/bin/env python3
"""Inspect an exported loop boundary and segment joins. See references/loop-review.md."""
import argparse
import base64
import html
import io
import json
import re
import subprocess
import sys
import wave
from fractions import Fraction
from pathlib import Path

import numpy as np
from PIL import Image

from video_reference import probe


def run(command):
    result = subprocess.run(command, capture_output=True)
    if result.returncode:
        raise ValueError(result.stderr.decode("utf-8", "replace")[-1400:])
    return result


def streams(path):
    info = json.loads(run(["ffprobe", "-v", "error", "-protocol_whitelist", "file", "-show_streams",
                           "-of", "json", str(path)]).stdout)["streams"]
    video = next(s for s in info if s["codec_type"] == "video" and not s.get("disposition", {}).get("attached_pic"))
    audio = next((s for s in info if s["codec_type"] == "audio"), None)
    return video, audio


def clock(path, video):
    # ISO BMFF AVC/HEVC video samples normally map one-to-one to presented pictures.
    # Count all PTS in display order and independently verify every sampled decode below.
    if path.suffix.lower() in {".mp4", ".mov", ".m4v"} and video["codec_name"] in {"h264", "hevc", "prores"}:
        raw = run(["ffprobe", "-v", "error", "-protocol_whitelist", "file", "-select_streams", "V:0",
                   "-show_packets", "-show_entries", "packet=pts,duration,flags", "-of", "csv=p=0", str(path)]).stdout
        rows = [line.split(b",") for line in raw.splitlines() if line.strip()]
        if rows and all(len(r) >= 3 and r[0].lstrip(b"-").isdigit() and b"D" not in r[2] for r in rows):
            packets = sorted((int(r[0]), int(r[1]) if r[1].isdigit() else 0) for r in rows)
            if (len(packets) == int(video.get("nb_frames") or 0) and packets[-1][1] > 0
                    and all(a[0] < b[0] for a, b in zip(packets, packets[1:]))):
                tick = Fraction(video["time_base"])
                pts = [p*tick for p, _ in packets]
                return pts + [pts[-1] + packets[-1][1]*tick], "container_samples_and_decoded_windows"
    meta, edges = probe(path)
    # A stream can start away from the container origin. Read the first decoded timestamp.
    first = run(["ffprobe", "-v", "error", "-protocol_whitelist", "file", "-select_streams", "V:0",
                 "-read_intervals", "%+#64", "-show_frames", "-show_entries", "frame=best_effort_timestamp",
                 "-of", "json", str(path)]).stdout
    frames = json.loads(first).get("frames", [])
    if not frames:
        raise ValueError("Could not establish the first video presentation timestamp")
    origin = int(frames[0]["best_effort_timestamp"]) * Fraction(meta["time_base"])
    return [origin + t for t in edges], "decoded_frames"


def read_window(path, edges, start, stop, size):
    # Seek in the interval before the first sample, then verify the actual presentation timestamps.
    seek = (edges[start-1] + edges[start]) / 2 if start else edges[0]
    command = ["ffmpeg", "-nostdin", "-hide_banner", "-v", "info", "-xerror", "-protocol_whitelist", "file", "-copyts"]
    if start:
        command += ["-seek_timestamp", "1", "-ss", f"{float(seek):.9f}"]
    w, h = size
    command += ["-i", str(path), "-map", "0:V:0", "-an", "-vf", f"scale={w}:{h}:flags=area,showinfo=checksum=0",
                "-frames:v", str(stop-start), "-fps_mode", "passthrough", "-pix_fmt", "rgb24", "-f", "rawvideo", "-"]
    result = run(command)
    log = result.stderr.decode("utf-8", "replace")
    rate = re.search(r"config in time_base: (\d+/\d+)", log)
    pts = re.findall(r"\bn:\s*\d+\s+pts:\s*(-?\d+)", log)
    if not rate or [int(p)*Fraction(rate[1]) for p in pts[:stop-start]] != edges[start:stop]:
        raise ValueError(f"Decoded timestamps disagree with the index near f{start}")
    if len(result.stdout) != (stop-start)*h*w*3:
        raise ValueError(f"Incomplete video window starting at f{start}")
    return np.frombuffer(result.stdout, np.uint8).reshape(stop-start, h, w, 3)


def picture_test(rgb, middle, flash_frames, hold_frames):
    # Compare the seam to nearby steps both across the canvas and on 4×4 patches.
    diffs = np.abs(np.diff(rgb.astype(np.int16), axis=0))
    full = diffs.mean(axis=(1, 2, 3))
    local = np.vstack([q.mean(axis=(1, 2, 3)) for row in np.array_split(diffs, 4, axis=1)
                       for q in np.array_split(row, 4, axis=2)]).max(axis=0)
    k = middle - 1
    context = np.arange(len(full)) != k
    levels = np.median(rgb, axis=(1, 2, 3))
    near_white = (rgb.min(axis=3) >= 200).mean(axis=(1, 2)) >= .85
    reference = float(np.quantile(full[context], .9))
    patch_ref = float(np.quantile(local[context], .9))
    evidence = {"rgb_step": round(float(full[k]), 3), "nearby_p90": round(reference, 3),
                "tile_step": round(float(local[k]), 3), "tile_nearby_p90": round(patch_ref, 3)}
    left, right = k, k+1
    while left > 0 and full[left-1] <= .12:
        left -= 1
    while right < len(rgb)-1 and full[right] <= .12:
        right += 1
    still = right-left+1 if full[k] <= .12 else 0
    evidence["near_still_frames_at_join"] = still
    evidence["still_reaches_window_edge"] = bool(still and (left == 0 or right == len(rgb)-1))
    if flash_frames:
        a, b = middle, middle
        while a > 0 and near_white[a-1]:
            a -= 1
        while b < len(rgb) and near_white[b]:
            b += 1
        evidence["boundary_white_frames"] = b-a
        isolated = 0 < a < b < len(rgb) and min(levels[a:b]) - max(levels[a-1], levels[b]) >= 30
        status = "expected_flash" if b-a == flash_frames and isolated else "flash_mismatch"
        if status == "expected_flash":
            # A one-frame splice between the expected flash and the incoming scene is still a fault.
            for side in (full[:a-1][::-1], full[b:]):
                if len(side) >= 4 and side[0] > max(6, 4*float(np.quantile(side[1:], .9))):
                    status = "flash_flank_review"
                    break
    elif hold_frames:
        status = "expected_hold" if still == hold_frames and not evidence["still_reaches_window_edge"] else "hold_mismatch"
    elif full[k] > max(4, 3*reference) or local[k] > max(12, 3*patch_ref):
        status = "jump"
    elif still == 2 and left > 0 and right < len(rgb)-1 and min(full[left-1], full[right]) > .55:
        status = "repeated_edge_frame"
    elif still > 2 and left > 0 and right < len(rgb)-1 and min(full[left-1], full[right]) > .55:
        status = "unplanned_hold_review"
    elif still:
        status = "observed_hold"
    else:
        status = "within_local_motion"
    return {"status": status, **evidence}


def audio_window(path, stream, start, end):
    rate, channels = int(stream["sample_rate"]), int(stream["channels"])
    first, last = round(start*rate), round(end*rate)
    command = ["ffmpeg", "-nostdin", "-v", "error", "-xerror", "-protocol_whitelist", "file", "-copyts"]
    if start > 1:
        command += ["-seek_timestamp", "1", "-ss", f"{float(start-1):.8f}"]
    filt = f"asettb=1/{rate},atrim=start_pts={first}:end_pts={last}"
    command += ["-i", str(path), "-map", "0:a:0", "-vn", "-af", filt, "-c:a", "pcm_f32le", "-f", "f32le", "-"]
    audio = np.frombuffer(run(command).stdout, dtype="<f4").reshape(-1, channels)
    if len(audio) != last-first or len(audio) < 8:
        return None
    return audio


def audio_test(path, stream, ranges, edges):
    if stream is None:
        return {"status": "no_audio_stream"}, None
    parts = [audio_window(path, stream, edges[a], edges[b]) for a, b in ranges]
    if any(part is None for part in parts):
        return {"status": "audio_coverage_review"}, None
    left, right = parts
    rate = int(stream["sample_rate"])
    n = min(len(left), len(right), max(8, int(.02*rate)))
    left_side, right_side = left[-n:], right[:n]
    jump = np.abs(right_side[0]-left_side[-1])
    normal = np.quantile(np.abs(np.r_[np.diff(left_side, axis=0), np.diff(right_side, axis=0)]), .99, axis=0)
    rms = np.sqrt([np.mean(a**2, axis=0) for a in [left_side, right_side]])
    delta_db = np.abs(20*np.log10(np.maximum(rms[0], 1e-6) / np.maximum(rms[1], 1e-6)))
    click = np.flatnonzero(jump > np.maximum(.04, 4*normal)) + 1
    level = np.flatnonzero((rms.max(axis=0) > .02) & (delta_db > 16)) + 1
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setparams((left.shape[1], 2, rate, 0, "NONE", "not compressed"))
        wf.writeframes((np.clip(np.concatenate(parts), -1, 1)*32767).astype("<i2").tobytes())
    return {"status": "audio_step_review" if len(click) or len(level) else "within_local_audio",
            "sample_rate": rate, "step": jump.round(5).tolist(), "local_p99": normal.round(5).tolist(),
            "click_channels": click.tolist(), "level_change_channels": level.tolist()}, buf.getvalue()


def uri(mime, data):
    return f"data:{mime};base64," + base64.b64encode(data).decode("ascii")


def jpeg(rgb):
    buf = io.BytesIO()
    Image.fromarray(rgb).save(buf, format="JPEG", quality=85)
    return uri("image/jpeg", buf.getvalue())


LABEL = {"expected_flash": "Согласованная белая вспышка", "flash_mismatch": "Проверить длительность и форму вспышки",
         "flash_flank_review": "Вспышка нужной длины. Проверить соседний кадр",
         "expected_hold": "Согласованный холд", "hold_mismatch": "Проверить длительность холда",
         "jump": "Скачок изображения", "repeated_edge_frame": "Возможный повтор граничного кадра",
         "unplanned_hold_review": "Холд в движении. Сверить с замыслом", "observed_hold": "Низкая активность на стыке",
         "within_local_motion": "В пределах соседнего движения",
         "no_audio_stream": "Файл без аудиодорожки", "within_local_audio": "Звуковой шаг в пределах порога",
         "audio_step_review": "Прослушать перепад сэмплов или уровня", "audio_coverage_review": "Проверить покрытие звуком"}
REVIEW = {"flash_mismatch", "flash_flank_review", "hold_mismatch", "jump", "repeated_edge_frame", "unplanned_hold_review",
          "audio_step_review", "audio_coverage_review"}


def html_report(report, previews):
    esc = html.escape
    title = esc(Path(report["source"]).name)
    out = [f"""<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Проверка стыков · {title}</title><style>body{{font:16px/1.45 system-ui;max-width:960px;margin:30px auto;padding:0 12px}}
section{{border-top:1px solid #aaa;padding-bottom:1em}} .stills{{display:flex;gap:8px;flex-wrap:wrap}} figure{{margin:0}}
figure img{{width:150px;max-width:40vw}} .player{{display:block;max-width:100%;margin:8px 0}} button,input{{margin:4px}}
output{{display:inline-block}} audio{{vertical-align:middle;max-width:100%}}</style><h1>Проверка стыков</h1>
<p>{title} · {report["frame_count"]} кадров · {report["fps"]} fps · {report["seconds"]:.3f} с.
<a href="review.json">Измерения JSON</a></p>"""]
    if report["global_issues"]:
        out.append("<p>" + esc(", ".join(report["global_issues"])) + "</p>")
    for entry, (images, sound) in zip(report["boundaries"], previews):
        label = "Замыкание цикла" if entry["kind"] == "wrap" else "Монтажный стык"
        indices = entry["frames"]
        m = entry["center"]
        view = [{"im": jpeg(im), "f": i, "ms": dt} for im, i, dt in zip(images, indices, entry["durations_ms"])]
        out.append(f"<section><h2>{label} · f{indices[m-1]} → f{indices[m]}</h2><p>{LABEL[entry['picture']['status']]} · "
                   f"{LABEL[entry['audio']['status']]}</p><div class='stills'>")
        for j in [m-2, m-1, m, m+1]:
            out.append(f"<figure><img src='{view[j]['im']}' alt='Кадр {indices[j]}'><figcaption>f{indices[j]}</figcaption></figure>")
        out.append(f"</div><img class='player' src='{view[m]['im']}' alt='Текущий кадр'>"
                   f"<button type='button'>Проиграть окрестность стыка</button><input aria-label='Кадр' type='range' "
                   f"min='0' max='{len(view)-1}' value='{m}'><output>f{indices[m]}</output>")
        if sound:
            out.append(f"<audio controls src='{uri('audio/wav', sound)}'></audio>")
        out.append("<script type='application/json'>" + json.dumps(view, separators=(",", ":")) + "</script></section>")
    out.append("""<script>for (const s of document.querySelectorAll('section')) {
const frames=JSON.parse(s.querySelector('script').textContent), slider=s.querySelector('input'), btn=s.querySelector('button');
let timer=null;
function show(i){slider.value=i;s.querySelector('.player').src=frames[i].im;s.querySelector('output').value='f'+frames[i].f;}
function stop(){clearTimeout(timer);timer=null;btn.textContent='Проиграть окрестность стыка';}
function play(i){show(i);timer=setTimeout(()=>i+1<frames.length?play(i+1):stop(),frames[i].ms);}
btn.onclick=()=>{if(timer!==null){stop();return;}btn.textContent='Пауза';play(0);};
slider.oninput=()=>{stop();show(+slider.value);};
}</script></html>""")
    return "\n".join(out)


def inspect(args):
    path = args.video.resolve(strict=True)
    if args.context < 3 or args.context > 120 or not 32 <= args.proxy <= 1024:
        raise ValueError("Use 3–120 frames per side and a proxy width between 32 and 1024")
    if args.once and (args.expect_flash or args.expect_hold or not args.join):
        raise ValueError("--once requires internal joins and excludes loop expectations")
    if any(v is not None and v <= 0 for v in [args.expect_frames, args.expect_flash, args.expect_hold]):
        raise ValueError("Expected counts must be positive")
    dest = args.out.resolve()
    dest.mkdir(parents=True, exist_ok=True)
    for filename in ["review.json", "review.html"]:
        if (dest / filename).exists():
            raise ValueError("Report already exists in this directory. Use a new output directory.")
    video, audio = streams(path)
    edges, method = clock(path, video)
    n = len(edges)-1
    try:
        rate = Fraction(video["avg_frame_rate"])
    except (KeyError, ValueError, ZeroDivisionError):
        rate = Fraction(n, 1)/(edges[-1]-edges[0])
    pts_tick = Fraction(video["time_base"])
    # Matroska can round the last PTS and truncate the signalled sample duration to whole ms.
    # Count only strictly monotone timestamps and tolerate one tick at the exclusive END.
    regular = (rate > 0 and all(abs(t-edges[0]-i/rate) < pts_tick for i, t in enumerate(edges[:-1]))
               and abs(edges[-1]-edges[0]-n/rate) <= min(pts_tick, 1/(2*rate)))
    timeline = [edges[0]+i/rate for i in range(n+1)] if regular else edges
    starts = sorted(set(args.join))
    if any(i <= 0 or i >= n for i in starts):
        raise ValueError("Internal join must be the first incoming frame, inside the stream")
    if not args.once:
        starts.append(0)
    aspect = Fraction(video["width"], video["height"])
    rot = next((float(s["rotation"]) for s in video.get("side_data_list", []) if "rotation" in s), 0)
    if abs(rot - round(rot/90)*90) > .01:
        raise ValueError("Supply an upright export for an arbitrary display rotation")
    sar = video.get("sample_aspect_ratio", "1:1")
    if sar not in {"N/A", "0:1", None}:
        aspect *= Fraction(sar.replace(":", "/"))
    if round(rot/90) % 2:
        aspect = 1/aspect
    w, h = ((args.proxy, round(args.proxy/aspect)) if aspect >= 1 else (round(args.proxy*aspect), args.proxy))
    w, h = max(4, w), max(4, h)
    issues = []
    if args.expect_frames and args.expect_frames != n:
        issues.append(f"Ожидалось кадров: {args.expect_frames}, найдено: {n}")
    if args.expect_fps and (not regular or rate != Fraction(args.expect_fps)):
        issues.append(f"Проверить частоту и равномерность кадров. Ожидалось {args.expect_fps} CFR")
    report = {"source": str(path), "frame_count": n, "clock_method": method, "fps": str(rate),
              "regular_grid": regular, "seconds": float(timeline[-1]-timeline[0]),
              "container_seconds": float(edges[-1]-edges[0]), "proxy": [w, h],
              "global_issues": issues, "boundaries": []}
    previews = []
    for at in starts:
        half = min(args.context, at or n//2, n-at if at else n//2)
        if half < 3:
            raise ValueError("Need at least three distinct frames on each side of every requested join")
        before, after = at or n, at
        ranges = [(before-half, before), (after, after+half)]
        if at:
            images = read_window(path, edges, at-half, at+half, (w, h))
        else:
            images = np.concatenate([read_window(path, edges, a, b, (w, h)) for a, b in ranges])
        indices = [f for a, b in ranges for f in range(a, b)]
        picture = picture_test(images, half, args.expect_flash if not at else None, args.expect_hold if not at else None)
        sound, samples = audio_test(path, audio, ranges, timeline)
        entry = {"kind": "internal" if at else "wrap", "first_incoming_frame": at, "center": half, "frames": indices,
                 "start_seconds": [round(float(edges[i]-edges[0]), 9) for i in indices],
                 "durations_ms": [round(float((timeline[i+1]-timeline[i])*1000), 6) for i in indices],
                 "picture": picture, "audio": sound}
        report["boundaries"].append(entry)
        previews.append((images, samples))
    flagged = bool(issues) or any(v["status"] in REVIEW for e in report["boundaries"] for v in [e["picture"], e["audio"]])
    report["status"] = "review" if flagged else "pass"
    page = html_report(report, previews)
    # Exclusive creation prevents concurrent deliveries from mixing two versions of an audit.
    # Publish HTML after its linked JSON. Remove only files reserved by this run on an error.
    created = []
    try:
        for name, content in [("review.json", json.dumps(report, ensure_ascii=False, indent=2)+"\n"),
                              ("review.html", page)]:
            file = dest/name
            with file.open("x", encoding="utf-8", newline="\n") as output:
                created.append(file)
                output.write(content)
    except (OSError, KeyboardInterrupt):
        for file in created:
            file.unlink(missing_ok=True)
        raise
    print(f"{report['status']}: {n} frames, {len(starts)} boundaries; {dest/'review.html'}")
    return int(flagged)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("video", type=Path)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--join", action="append", type=int, default=[], metavar="FRAME", help="first frame of next segment")
    parser.add_argument("--once", action="store_true", help="one-shot program, inspect internal joins only")
    intent = parser.add_mutually_exclusive_group()
    intent.add_argument("--expect-flash", type=int, metavar="N", help="expected count of bright near-white frames at wrap")
    intent.add_argument("--expect-hold", type=int, metavar="N", help="expected total near-identical frames across wrap")
    parser.add_argument("--expect-frames", type=int)
    parser.add_argument("--expect-fps", help="expected constant video frame rate (e.g. 30000/1001)")
    parser.add_argument("--context", type=int, default=12, help="frames per side")
    parser.add_argument("--proxy", type=int, default=360, help="longest analysis side")
    args = parser.parse_args()
    try:
        return inspect(args)
    except (OSError, ValueError, KeyError, StopIteration, ZeroDivisionError) as e:
        parser.exit(2, f"loop review: {e}\n")


if __name__ == "__main__":
    sys.exit(main())
