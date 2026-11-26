#!/usr/bin/env python3
"""Compare two local exports on the same edit clock. See references/version-review.md."""

import argparse
import html
import json
import math
import os
import re
import subprocess
import sys
import tempfile
from contextlib import contextmanager, ExitStack
from fractions import Fraction
from pathlib import Path
from urllib.parse import quote

import numpy as np

from takecheck import probe_video


PATCH_W, PATCH_H = 96, 64
AUDIO_RATE = 8000


def probe(path):
    if not path.is_file():
        raise ValueError(f"missing input: {path}")
    args = [
        "ffprobe",
        "-v",
        "error",
        "-protocol_whitelist",
        "file",
        "-show_streams",
        "-show_format",
        "-of",
        "json",
        "-i",
        str(path),
    ]
    result = subprocess.run(args, capture_output=True, check=True, encoding="utf-8")
    meta = json.loads(result.stdout)
    video = next((s for s in meta["streams"] if s["codec_type"] == "video"), None)
    if not video:
        raise ValueError(f"no picture in {path}")
    audio = next((s for s in meta["streams"] if s["codec_type"] == "audio"), None)
    rate = Fraction(video["avg_frame_rate"])
    if rate <= 0:
        raise ValueError(f"unknown video frame rate in {path}")
    duration = float(video.get("duration") or meta["format"]["duration"])
    try:
        frames = probe_video(path, rate)
        clock_error = None
    except ValueError as err:
        frames = None
        clock_error = str(err)
    if frames is not None:
        duration = frames / float(rate)
    rotation = next((float(s["rotation"]) for s in video.get("side_data_list", []) if "rotation" in s), 0)
    coded = [video["width"], video["height"]]
    sar = video.get("sample_aspect_ratio", "1:1")
    sar = "1:1" if sar in ("0:1", "N/A") else sar
    quarter_turn = round(rotation / 90) % 2
    return {
        "path": str(path),
        "coded_size": coded,
        "size": coded[::-1] if quarter_turn else coded,
        "fps": str(rate),
        "embedded_start_tc": video.get("tags", {}).get("timecode")
        or meta["format"].get("tags", {}).get("timecode"),
        "frames": frames,
        "clock_error": clock_error,
        "video_duration_s": duration,
        "start_s": float(video.get("start_time", 0)),
        "sar": ":".join(sar.split(":")[::-1]) if quarter_turn else sar,
        "rotation": rotation,
        "audio": None
        if not audio
        else {
            "channels": audio["channels"],
            "layout": audio.get("channel_layout"),
            "start_s": float(audio.get("start_time", 0)),
        },
    }


def region_arg(value):
    name, separator, geom = value.partition("=" if "=" in value else ":")
    try:
        x, y, w, h = map(int, geom.split(","))
    except ValueError as err:
        raise argparse.ArgumentTypeError("ROI must be NAME=X,Y,W,H") from err
    if not name or not separator or min(x, y) < 0 or min(w, h) < 1:
        raise argparse.ArgumentTypeError("ROI needs a name and a positive rectangle")
    return name, (x, y, w, h)


def frame_range(value):
    try:
        start, end = map(int, value.split(":"))
    except ValueError as err:
        raise argparse.ArgumentTypeError("use START:END frames") from err
    if not 0 <= start < end:
        raise argparse.ArgumentTypeError("use 0 <= START < END")
    return start, end


def anchor_pair(value):
    try:
        before, after = map(int, value.split(":"))
    except ValueError as err:
        raise argparse.ArgumentTypeError("use BEFORE_FRAME:AFTER_FRAME") from err
    if min(before, after) < 0:
        raise argparse.ArgumentTypeError("anchor frames must be nonnegative")
    return before, after


def permitted(frame, windows):
    return any(start <= frame < stop for start, stop in windows)


def add_event(events, frame, score, allowed):
    if not events or events[-1]["out"] != frame or events[-1]["allowed"] != allowed:
        events.append({"in": frame, "out": frame + 1, "allowed": allowed, "worst_frame": frame, "peak": score})
    event = events[-1]
    event["out"] = frame + 1
    if score > event["peak"]:
        event["peak"], event["worst_frame"] = score, frame
    return event


@contextmanager
def pictures(path, rectangles, start):
    streams = []
    source = "[0:v:0]"
    if start:
        streams.append(f"{source}trim=start_frame={start}[start]")
        source = "[start]"
    if len(rectangles) > 1:
        streams.append(
            source + "split=%d%s" % (len(rectangles), "".join(f"[s{i}]" for i in range(len(rectangles))))
        )
    for i, rect in enumerate(rectangles):
        channel = f"[s{i}]" if len(rectangles) > 1 else source
        crop = "" if rect is None else "crop=%d:%d:%d:%d:exact=1," % (rect[2], rect[3], rect[0], rect[1])
        streams.append(f"{channel}{crop}scale={PATCH_W}:{PATCH_H}:flags=area,format=rgb24[p{i}]")
    label = "[p0]"
    if len(rectangles) > 1:
        streams.append(
            "".join(f"[p{i}]" for i in range(len(rectangles))) + f"vstack=inputs={len(rectangles)}[v]"
        )
        label = "[v]"
    cmd = [
        "ffmpeg",
        "-nostdin",
        "-v",
        "error",
        "-protocol_whitelist",
        "file",
        "-i",
        str(path),
        "-filter_complex_threads",
        "1",
        "-filter_complex",
        ";".join(streams),
        "-map",
        label,
        "-fps_mode",
        "passthrough",
        "-threads:v",
        "1",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "-",
    ]
    # Redirect diagnostics to a seekable file: a decoder error must not fill an unread pipe.
    with (
        tempfile.TemporaryFile() as errors,
        subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=errors) as proc,
    ):
        try:
            yield proc.stdout
        finally:
            proc.stdout.close()
            if proc.poll() is None:
                proc.terminate()
            proc.wait()


def read_picture(reader, count, frame):
    size = count * PATCH_W * PATCH_H * 3
    raw = reader.read(size)
    if len(raw) != size:
        raise ValueError(f"FFmpeg stopped before decoded frame {frame}")
    return np.frombuffer(raw, np.uint8).reshape(count, -1).astype(np.int16)


def picture_review(paths, starts, names, rectangles, common, lag_limit, threshold, windows):
    # A score at t compares candidate[t] with baseline[t-lag]. Keep only the local search band.
    before, after = {}, {}
    rows = {name: [] for name in names}
    with ExitStack() as stack:
        readers = [stack.enter_context(pictures(path, rectangles, start)) for path, start in zip(paths, starts)]
        for step in range(common + lag_limit):
            if step < common:
                before[step] = read_picture(readers[0], len(names), step)
                after[step] = read_picture(readers[1], len(names), step)
            t = step - lag_limit
            if t < 0:
                continue
            candidate = after.pop(t)
            diffs = np.abs(candidate - before[t]).mean(axis=1)
            for i in np.flatnonzero(diffs > threshold):
                event = add_event(rows[names[i]], t, float(diffs[i]), permitted(t, windows))
                costs = event.setdefault("_costs", {})
                for lag in range(-lag_limit, lag_limit + 1):
                    baseline = before.get(t - lag)
                    if baseline is not None:
                        stat = costs.setdefault(lag, [0.0, 0])
                        stat[0] += float(np.abs(candidate[i] - baseline[i]).mean())
                        stat[1] += 1
            before.pop(t - lag_limit, None)
    for events in rows.values():
        for event in events:
            tally = event.pop("_costs")
            scores = sorted(
                (total / count, lag)
                for lag, (total, count) in tally.items()
                if count == event["out"] - event["in"]
            )
            zero = tally[0][0] / tally[0][1]
            best, lag = scores[0]
            runner = scores[1][0] if len(scores) > 1 else best
            # A plateau, a single changed frame and many arbitrary replacements admit
            # multiple alignments. Publish a lag only for a distinct, close match.
            clear = (
                event["out"] - event["in"] >= 2
                and lag != 0
                and best <= threshold
                and best < zero * 0.45
                and runner - best > max(0.3, zero * 0.08)
            )
            event["lag_frames"] = lag if clear else None
            event["same_frame_mae"] = round(zero, 3)
            event["best_match_mae"] = round(best, 3)
            event["peak"] = round(event["peak"], 3)
    return rows


def decode_audio(meta, target):
    cmd = [
        "ffmpeg",
        "-nostdin",
        "-v",
        "error",
        "-protocol_whitelist",
        "file",
        "-i",
        meta["path"],
        "-map",
        "0:a:0",
        "-vn",
        "-ar",
        str(AUDIO_RATE),
        "-f",
        "s16le",
        "-c:a",
        "pcm_s16le",
        str(target),
    ]
    subprocess.run(cmd, capture_output=True, check=True)
    channels = meta["audio"]["channels"]
    if target.stat().st_size == 0:
        return np.empty((0, channels), dtype=np.int16)
    return np.memmap(target, dtype="<i2", mode="r").reshape(-1, channels)


def sample_block(pcm, origin, start, stop):
    """Render a block on the picture clock. Account for an audio stream starting before or after it."""
    block = np.zeros((stop - start, pcm.shape[1]), dtype=np.float32)
    left, right = max(start, origin), min(stop, origin + len(pcm))
    if left < right:
        block[left - start : right - start] = pcm[left - origin : right - origin]
    return block


def match_window(reference, search, radius):
    n = len(reference)
    ref = reference - reference.mean()
    power = np.dot(ref, ref)
    if power < n * 30**2:
        return None
    length = 1 << (len(search) + n - 2).bit_length()
    fft = np.fft.rfft(search, length) * np.fft.rfft(ref[::-1], length)
    cross = np.fft.irfft(fft, length)[n - 1 : len(search)]
    energy = np.r_[0.0, np.cumsum(search.astype(float) ** 2)]
    sums = np.r_[0.0, np.cumsum(search, dtype=float)]
    norms = np.sqrt(np.maximum(energy[n:] - energy[:-n] - (sums[n:] - sums[:-n]) ** 2 / n, 0) * power)
    scores = np.divide(cross, norms, out=np.zeros_like(cross), where=norms > 0)
    index = int(np.argmax(scores))
    peak = float(scores[index])
    # Peak uniqueness must survive outside a two-millisecond neighbourhood.
    exclusion = round(0.002 * AUDIO_RATE)
    scores[max(0, index - exclusion) : index + exclusion + 1] = -1
    if peak < 0.70 or peak - max(scores) < 0.035:
        return None
    return {"lag_samples": index - radius, "correlation": round(min(peak, 1.0), 4)}


def sound_review(a, b, folder, fps, common, anchors, windows, floor_db, audio_lag_frames):
    if not a["audio"] and not b["audio"]:
        return {"status": "no_audio_in_either_export", "events": []}
    if not a["audio"] or not b["audio"] or a["audio"]["channels"] != b["audio"]["channels"]:
        return {"status": "track_or_channel_count_changed", "events": []}
    if a["audio"]["layout"] and b["audio"]["layout"] and a["audio"]["layout"] != b["audio"]["layout"]:
        return {"status": "channel_layout_changed", "events": []}
    pcm = []
    try:
        for i, meta in enumerate((a, b)):
            pcm.append(decode_audio(meta, folder / f"{i}.pcm"))
        starts = [
            round((m["audio"]["start_s"] - m["start_s"] - frame / fps) * AUDIO_RATE)
            for m, frame in zip((a, b), anchors)
        ]

        def sample(frame):
            return round(frame * AUDIO_RATE / fps)

        total = sample(common)
        events = []
        # Batches bound float memory and keep channel-specific changes from cancelling.
        for f in range(0, common, 100):
            stop = min(f + 100, common)
            chunks = [sample_block(p, o, sample(f), sample(stop)) for p, o in zip(pcm, starts)]
            err = (chunks[1] - chunks[0]) ** 2
            for i in range(f, stop):
                segment = err[sample(i) - sample(f) : sample(i + 1) - sample(f)]
                rms = math.sqrt(float(segment.mean(axis=0).max()))
                if rms > 32768 * 10 ** (floor_db / 20):
                    add_event(events, i, round(20 * math.log10(rms / 32768), 2), permitted(i, windows))
        radius = min(sample(audio_lag_frames), total // 6)
        n = min(2 * AUDIO_RATE, total - 2 * radius)
        votes = []
        if radius > 0 and n >= AUDIO_RATE // 5:
            anchors = np.unique(np.linspace(radius, total - n - radius, 7, dtype=int))
            for pos in anchors:
                pos = int(pos)
                ref = sample_block(pcm[0], starts[0], pos, pos + n)
                search = sample_block(pcm[1], starts[1], pos - radius, pos + n + radius)
                channel = int(np.argmax(ref.var(axis=0)))
                guess = match_window(ref[:, channel], search[:, channel], radius)
                if guess:
                    votes.append(dict(guess, at_s=round(pos / AUDIO_RATE, 3), channel=channel + 1))
        lag = None
        if votes:
            shifts = np.array([x["lag_samples"] for x in votes])
            median = float(np.median(shifts))
            keep = np.abs(shifts - median) <= AUDIO_RATE * 0.003
            if keep.sum() > len(votes) / 2:
                lag = float(np.median(shifts[keep])) / AUDIO_RATE
        ends = [(o + len(p)) / AUDIO_RATE for o, p in zip(starts, pcm)]
        return {
            "status": "measured" if lag is not None else "no_unique_shared_signal",
            "events": events,
            "anchors": votes,
            "lag_ms": None if lag is None else round(lag * 1000, 3),
            "lag_frames": None if lag is None else round(lag * fps, 3),
            "audio_end_on_review_clock_s": ends,
        }
    finally:
        for p in pcm:
            if isinstance(p, np.memmap):
                p._mmap.close()


def media_url(path, folder):
    try:
        rel = os.path.relpath(path, folder)
    except ValueError:
        return Path(path).as_uri()
    return quote(Path(rel).as_posix(), safe="/.")


def review_page(report, folder, hold_section=""):
    a, b = report["before"], report["after"]
    fps = float(Fraction(a["fps"]))
    total = report["common_frames"] or max(1, int(min(a["video_duration_s"], b["video_duration_s"]) * fps))
    events = [(name, ev) for name, items in report["picture"].items() for ev in items]
    events.extend(("Звук", ev) for ev in report["sound"].get("events", []))
    rows = []
    for name, ev in sorted(events, key=lambda v: v[1]["in"]):
        allowed = "согласовано" if ev["allowed"] else "проверить"
        lag = ev.get("lag_frames")
        shift = "" if lag is None else f" · {lag:+d} кадр."
        rows.append(
            f'<li><button data-frame="{ev["worst_frame"]}">{html.escape(name)} · '
            f"{ev['in']}–{ev['out'] - 1} · {allowed}{shift}</button></li>"
        )
    warnings = "".join(f"<li>{html.escape(w)}</li>" for w in report["notes"])
    panels = []
    for title, meta in (("До", a), ("После", b)):
        description = (
            f"{Path(meta['path']).name} · {meta['size'][0]}×{meta['size'][1]} · "
            f"{meta['fps']} fps · {meta['video_duration_s']:.3f} с"
        )
        if meta["embedded_start_tc"]:
            description += f" · стартовый TC {meta['embedded_start_tc']}"
        panels.append(
            f'<section><h2>{title}</h2><video muted preload="auto" '
            f'src="{html.escape(media_url(meta["path"], folder), quote=True)}"></video>'
            f"<p>{html.escape(description)}</p></section>"
        )
    videos = "".join(panels)
    template = """<!doctype html><html lang="ru"><meta charset="utf-8"><title>Сверка экспортов</title>
<style>body{background:#181b20;color:#eee;font:16px system-ui;margin:24px}main{display:flex;gap:12px}section{width:50%}video{width:100%;max-height:55vh;background:#000}button,select{padding:.4rem}input{width:48vw}li{margin:5px}h2{font-size:1rem}</style>
<h1>Сверка экспортов</h1><main>VIDEOS</main><p><button id="play">Пуск / пауза</button>
<button id="prev">−1 кадр</button><button id="next">+1 кадр</button>
<select id="listen" aria-label="Слушать"><option>Без звука</option><option>Звук до</option><option>Звук после</option></select></p>
<input id="slider" type="range" min="0" value="0" max="LAST"><output id="counter"></output>
<p id="info"></p><p>STATUS</p><ul>NOTES</ul><h2>Найденные интервалы</h2><ul>ROWS</ul>
HOLD_SECTION
<script>
const [a,b]=document.querySelectorAll('video'),fps=RATE_A,fpsB=RATE_B,last=LAST,origin=ORIGINS;
const sl=document.querySelector('#slider'),counter=document.querySelector('#counter'),listen=document.querySelector('#listen');
let pending=0; const rates=[fps,fpsB];function target(i,f){return origin[i]/rates[i]+(f+.35)/fps;}
function stamp(s){const ms=Math.round(s*1000);return [Math.floor(ms/3600000),Math.floor(ms/60000)%60,Math.floor(ms/1000)%60].map(t=>String(t).padStart(2,'0')).join(':')+'.'+String(ms%1000).padStart(3,'0');}
function paint(f){const fa=origin[0]+f,fb=Math.floor(target(1,f)*fpsB);sl.value=f;counter.textContent=' кадр '+f+' · '+(f/fps).toFixed(3)+' с · до '+fa+' ('+stamp(fa/fps)+') / после '+fb+' ('+stamp(fb/fpsB)+')';}
function pause(){a.pause();b.pause();} function go(f){pause();pending=Math.max(0,Math.min(last,Number(f)));[a,b].forEach((v,i)=>{if(v.readyState)v.currentTime=target(i,pending);});paint(pending);}
[a,b].forEach((v,i)=>{v.onloadedmetadata=()=>{if(origin[i]||pending)v.currentTime=target(i,pending);};v.onerror=()=>{document.querySelector('#info').textContent='Браузер не открыл этот кодек или исходный путь. Для просмотра используйте доступные локальные MP4.';pause();};});
sl.oninput=()=>go(sl.value);document.querySelector('#prev').onclick=()=>go(+sl.value-1);document.querySelector('#next').onclick=()=>go(+sl.value+1);
document.querySelectorAll('[data-frame]').forEach(x=>x.onclick=()=>go(x.dataset.frame));
listen.onchange=()=>{a.muted=listen.selectedIndex!==1;b.muted=listen.selectedIndex!==2;};
const delta=origin[1]/fpsB-origin[0]/fps;
document.querySelector('#play').onclick=async()=>{if(!a.paused){pause();return;}if(+sl.value>=last)go(0);b.currentTime=a.currentTime+delta;try{await Promise.all([a.play(),b.play()]);}catch(e){pause();}};
function tick(){if(!a.paused){const f=Math.max(0,Math.floor(a.currentTime*fps)-origin[0]);if(f>=last)go(last);else{paint(f);if(Math.abs(b.currentTime-a.currentTime-delta)>1/fps)b.currentTime=a.currentTime+delta;}}requestAnimationFrame(tick);}
paint(0);tick();
</script></html>"""
    sound = report["sound"]
    audio_labels = {
        "no_audio_in_either_export": "оба экспорта без аудиодорожки",
        "no_unique_shared_signal": "сдвиг неопределён, общего различимого сигнала мало",
        "track_or_channel_count_changed": "разный набор дорожек или каналов",
        "channel_layout_changed": "разная раскладка каналов",
        "no_common_frame_clock": "общая покадровая шкала недоступна",
        "measured": "сдвиг измерен",
    }
    status = (
        ("Требуется сверка" if report["status"] == "review" else "Пройдено")
        + " · звук: "
        + audio_labels[sound["status"]]
    )
    if sound.get("lag_ms") is not None:
        status += f" · сдвиг «после» {sound['lag_ms']:+g} мс ({sound['lag_frames']:+g} кадр.)"
    values = {
        "VIDEOS": videos,
        "RATE_A": str(fps),
        "RATE_B": str(float(Fraction(b["fps"]))),
        "LAST": str(total - 1),
        "ROWS": "".join(rows),
        "HOLD_SECTION": hold_section,
        "NOTES": warnings,
        "STATUS": html.escape(status),
        "ORIGINS": json.dumps(report["start_frames"]),
    }
    return re.sub("|".join(values), lambda match: values[match.group()], template)


def compare(args):
    paths = [p.resolve(strict=True) for p in (args.before, args.after)]
    out = args.out.resolve()
    targets = [out / "review.json", out / "review.html"]
    if any(target.exists() or target.is_symlink() for target in targets):
        raise ValueError("review.json or review.html already exists; choose a fresh --out directory")
    metas = [probe(path) for path in paths]
    a, b = metas
    notes = []
    for key in ("fps", "size", "sar"):
        if a[key] != b[key]:
            notes.append(f"{key}: {a[key]} → {b[key]}.")
    for meta in metas:
        if abs(meta["rotation"] - round(meta["rotation"] / 90) * 90) > 0.01:
            notes.append(
                f"{Path(meta['path']).name}: для произвольного угла поворота нужен вертикально ориентированный экспорт."
            )
        if meta["clock_error"]:
            notes.append(f"{Path(meta['path']).name}: {meta['clock_error']}.")
    names = ["Кадр"] + [name for name, _ in args.roi]
    if len(set(names)) != len(names):
        raise ValueError("ROI names must be unique")
    rects = [r for _, r in args.roi]
    for x, y, w, h in rects:
        if x + w > a["size"][0] or y + h > a["size"][1]:
            raise ValueError("ROI exceeds baseline dimensions")
    common = None
    if a["frames"] and b["frames"] and a["fps"] == b["fps"]:
        available = [m["frames"] - start for m, start in zip(metas, args.align)]
        if min(available) <= 0:
            raise ValueError("aligned frame lies beyond the end of an input")
        if args.frames and args.frames > min(available):
            raise ValueError("requested review range exceeds one of the inputs")
        common = args.frames or min(available)
    elif any(args.align) or args.frames:
        raise ValueError("manual frame alignment needs two verified matching CFR clocks")
    compatible = not notes
    if args.hold and (not compatible or not common):
        raise ValueError("hold samples need matching display geometry and verified CFR clocks")
    if any(stop - start < 2 or stop > common for start, stop in args.hold):
        raise ValueError("each hold needs at least two frames inside the common picture interval")
    issues = list(notes)
    if any(args.align) or args.frames:
        notes.append(
            f"Проверяется диапазон {common} кадров от якорей до {args.align[0]} и после {args.align[1]}. Кадры вне диапазона исключены из проверки."
        )
    if a["frames"] != b["frames"]:
        notes.append(
            f"Длина файлов: {a['frames']} / {b['frames']} кадров. Общий участок содержит {common} кадров. После перемонтажа сопоставьте участок по кадрам события."
        )
    if common and not args.frames and available[0] != available[1]:
        issues.append("unmatched_picture_tail")
    if common and any(stop > common for _, stop in args.allow + args.allow_video + args.allow_audio):
        raise ValueError("an allowed window lies outside the common picture interval")
    picture = {}
    if compatible and common:
        picture = picture_review(
            paths,
            args.align,
            names,
            [None, *rects],
            common,
            args.max_shift,
            args.mae,
            args.allow + args.allow_video,
        )
    else:
        notes.append(
            "Автоматическая сверка изображения требует совпадающих геометрии, ориентации и частоты CFR."
        )
    out.mkdir(parents=True, exist_ok=True)
    fps = float(Fraction(a["fps"]))
    with tempfile.TemporaryDirectory() as tmp:
        sound = (
            sound_review(
                a,
                b,
                Path(tmp),
                fps,
                common,
                args.align,
                args.allow + args.allow_audio,
                args.audio_floor_db,
                args.audio_search,
            )
            if common
            else {"status": "no_common_frame_clock", "events": []}
        )
    if sound["status"] in ("track_or_channel_count_changed", "channel_layout_changed"):
        issues.append(sound["status"])
        notes.append("Изменился состав или раскладка аудиоканалов.")
    ends = sound.get("audio_end_on_review_clock_s", [])
    if ends and not args.frames and abs(ends[1] - ends[0]) > 1 / fps:
        notes.append("Длины фонограмм различаются больше чем на кадр; проверить хвосты.")
        issues.append("audio_duration")
    unexpected = sum(not event["allowed"] for rows in [*picture.values(), sound["events"]] for event in rows)
    if sound.get("lag_ms") is not None and abs(sound["lag_frames"]) >= 0.5 and not sound["events"]:
        # A quiet shared track may sit under the residual floor even with a measurable delay.
        if not all(permitted(i, args.allow + args.allow_audio) for i in range(common)):
            issues.append("audio_offset")
    hold_review = None
    hold_section = ""
    if args.hold:
        try:
            from hold_review import analyze
        except ModuleNotFoundError as err:
            if err.name == "PIL":
                raise ValueError("--hold previews require Pillow in this Python environment") from err
            raise

        hold_review, hold_section = analyze(
            paths,
            args.align,
            a["size"],
            args.hold,
            args.mae,
            args.allow + args.allow_video,
        )
        local_frames = {f for h in hold_review["holds"] for f in h["unexpected_frames"]}
        if local_frames:
            issues.append("local_hold_difference")
            notes.append(f"Локальные различия выше порога на {len(local_frames)} кадрах удержаний.")
    report = {
        "status": "review" if issues or unexpected else "pass",
        "before": a,
        "after": b,
        "clock": "Review frame 0 corresponds to start_frames in BEFORE/AFTER. Positive lag means the candidate is late.",
        "start_frames": list(args.align),
        "common_frames": common,
        "unexpected_intervals": unexpected,
        "allow": {"both": args.allow, "picture": args.allow_video, "audio": args.allow_audio},
        "rois": dict(args.roi),
        "mae_threshold": args.mae,
        "audio_floor_dbfs": args.audio_floor_db,
        "picture": picture,
        "sound": sound,
        "notes": notes,
        "issues": issues,
    }
    if hold_review is not None:
        report["hold_review"] = hold_review
    documents = [
        json.dumps(report, ensure_ascii=False, indent=2),
        review_page(report, out, hold_section),
    ]
    created = []
    try:
        for target, document in zip(targets, documents):
            with target.open("x", encoding="utf-8") as output:
                created.append(target)
                output.write(document)
    except OSError:
        for target in created:
            target.unlink(missing_ok=True)
        raise
    return report


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("before", type=Path)
    p.add_argument("after", type=Path)
    p.add_argument("--out", type=Path, required=True)
    p.add_argument("--roi", type=region_arg, action="append", default=[], metavar="NAME=X,Y,W,H")
    p.add_argument(
        "--align",
        type=anchor_pair,
        default=(0, 0),
        metavar="BEFORE:AFTER",
        help="original frame numbers of the same known event; review begins at this pair",
    )
    p.add_argument("--frames", type=int, help="review only this many frames after the anchors")
    p.add_argument(
        "--hold",
        type=frame_range,
        action="append",
        default=[],
        metavar="START:END",
        help="inspect automatic spatial tiles at start, middle and final included frame of a reading hold",
    )
    for flag in ("--allow", "--allow-video", "--allow-audio"):
        p.add_argument(flag, type=frame_range, action="append", default=[], metavar="START:END")
    p.add_argument("--mae", type=float, default=4.0, help="mean absolute RGB difference, 0..255")
    p.add_argument("--max-shift", type=int, default=6, help="local picture lag search radius, frames")
    p.add_argument("--audio-floor-db", type=float, default=-42.0, help="per-frame residual RMS in dBFS")
    p.add_argument("--audio-search", type=int, default=12, help="sound offset search radius, frames")
    args = p.parse_args()
    if args.frames is not None and args.frames < 1:
        p.error("--frames must be positive")
    if not (
        0 < args.mae < 255
        and -120 <= args.audio_floor_db < 0
        and 1 <= args.max_shift <= 60
        and 1 <= args.audio_search <= 120
    ):
        p.error("invalid threshold or lag search radius")
    try:
        report = compare(args)
    except (ValueError, OSError, subprocess.CalledProcessError, ZeroDivisionError) as err:
        print(str(err), file=sys.stderr)
        return 2
    summary = f"{report['status']}: {report['unexpected_intervals']} unexpected intervals"
    if args.hold:
        frames = {f for hold in report["hold_review"]["holds"] for f in hold["unexpected_frames"]}
        summary += f", {len(frames)} unexpected local hold frames"
    print(f"{summary}; {args.out / 'review.html'}")
    return 1 if report["status"] == "review" else 0


if __name__ == "__main__":
    sys.exit(main())
