#!/usr/bin/env python3
"""Verify a planned shot list against local files, at normal speed on a CFR timeline.

    python scripts/takecheck.py sheet.json [--shot F05K5]
    python scripts/takecheck.py sheet.json --shot F05K5 --frames context.png [--version v02] [--action-frame 72]

See references/staged-shots.md for the production sheet and frame conventions.
Exit 0 = technical pass, 1 = unresolved selection or media, 2 = invalid input.
"""
import argparse
import json
import subprocess
import sys
from fractions import Fraction
from functools import lru_cache
from pathlib import Path


def required_text(obj, key, at):
    value = obj.get(key)
    if not isinstance(value, str) or not value.strip() or value.strip() != value:
        raise ValueError(f"{at}: {key} must be nonempty text without outer spaces")
    return value


def frame_range(value, at):
    if (not isinstance(value, list) or len(value) != 2
            or any(type(frame) is not int for frame in value)
            or not 0 <= value[0] < value[1]):
        raise ValueError(f"{at}: expected [in, out) as two increasing nonnegative integers")


def validate_shots(sheet):
    if not isinstance(sheet, dict) or not isinstance(sheet.get("shots"), list) or not sheet["shots"]:
        raise ValueError("expected a nonempty shots list containing the planned shots")
    rate = sheet.get("fps")
    if type(rate) not in (int, str):
        raise ValueError("fps must be a positive integer or a rational string")
    fps = Fraction(rate)
    if fps <= 0:
        raise ValueError("fps must be positive")

    shots = {}
    for index, shot in enumerate(sheet["shots"]):
        if not isinstance(shot, dict):
            raise ValueError(f"shots[{index}]: expected an object")
        key = required_text(shot, "shot", f"shots[{index}]")
        required_text(shot, "scene", key)
        if key in shots:
            raise ValueError(f"{key}: duplicate shot ID")
        shots[key] = shot
        frame_range(shot.get("cut"), f"{key} cut")
        if not isinstance(shot.get("takes"), list):
            raise ValueError(f"{key}: expected takes list (use [] for an open shot)")

        versions = {}
        for take in shot["takes"]:
            if not isinstance(take, dict):
                raise ValueError(f"{key}: expected a take object")
            version = required_text(take, "version", key)
            at = f"{key}/{version}"
            if version in versions:
                raise ValueError(f"{at}: duplicate version")
            if take.get("status") not in ("accepted", "archive", "review", "reject"):
                raise ValueError(f"{at}: unknown take status {take.get('status')!r}")
            if "file" in take:
                required_text(take, "file", at)
            if "use" in take:
                frame_range(take["use"], f"{at} use")
            if "replaces" in take:
                required_text(take, "replaces", at)
            versions[version] = take.get("replaces")

        checked = set()
        for version in versions:
            path = set()
            target = version
            while target is not None and target not in checked:
                if target not in versions:
                    raise ValueError(f"{key}/{version}: replacement target {key}/{target} is missing")
                if target in path:
                    raise ValueError(f"{key}/{version}: replacement cycle at {key}/{target}")
                path.add(target)
                target = versions[target]
            checked.update(path)
    return fps, shots


@lru_cache(maxsize=32)
def probe_video(file, fps):
    """Count decoded frames and prove their presentation times match the timeline grid."""
    if not file.is_file():
        raise ValueError(f"missing file: {file}")
    result = subprocess.run([
        "ffprobe", "-v", "error", "-protocol_whitelist", "file", "-select_streams", "v:0",
        "-show_frames", "-show_streams", "-show_entries",
        "stream=time_base,avg_frame_rate,start_pts,duration_ts:frame=pts,duration,pkt_duration",
        "-of", "json", "-i", str(file),
    ], capture_output=True, encoding="utf-8", errors="replace")
    if result.returncode or result.stderr.strip():
        raise ValueError(f"ffprobe: {result.stderr.strip() or result.returncode}")

    info = json.loads(result.stdout)
    frames = info.get("frames", [])
    if not frames or not info.get("streams"):
        raise ValueError("first video stream has no decoded frames")
    stream = info["streams"][0]
    try:
        actual_rate = Fraction(stream["avg_frame_rate"])
        tick = Fraction(stream["time_base"])
        timestamps = [int(frame["pts"]) for frame in frames]
        last_length = frames[-1].get("duration", frames[-1].get("pkt_duration"))
        if last_length is None:
            last_length = int(stream["start_pts"]) + int(stream["duration_ts"]) - timestamps[-1]
        last_length = int(last_length)
    except (KeyError, ValueError, TypeError, ZeroDivisionError) as error:
        raise ValueError(f"unverified video clock: {error}") from error

    if actual_rate != fps:
        raise ValueError(f"source fps={actual_rate}, timeline fps={fps}; supply a 1:1 CFR conform")
    if tick <= 0 or last_length <= 0:
        raise ValueError("unverified frame or time-base duration")
    # A rational cadence in a coarse container clock (e.g. Matroska milliseconds)
    # can land between ticks. Reject deviations of a whole tick or more and repeated PTS.
    ticks_per_frame = 1 / (tick * fps)
    timestamps.append(timestamps[-1] + last_length)
    for index in range(1, len(timestamps)):
        elapsed = timestamps[index] - timestamps[0]
        if timestamps[index] <= timestamps[index - 1] or abs(elapsed - index * ticks_per_frame) >= 1:
            raise ValueError(f"off-grid PTS at boundary {index}; check VFR, retime or conform")
    return len(frames)


def placed_range(shot, take, folder, fps):
    if "file" not in take or "use" not in take:
        raise ValueError("take needs file and use")
    file = folder / take["file"]
    count = probe_video(file, fps)
    first, stop = take["use"]
    needed = shot["cut"][1] - shot["cut"][0]
    available = max(0, min(stop, count) - first)
    if stop > count or available < needed:
        raise ValueError(f"{file}: decoded={count}, use=[{first},{stop}), "
                         f"{available} frames available from IN, {needed} needed")
    return file, first, first + needed - 1, count


def check_shot(shot, folder, fps):
    key = shot["shot"]
    start, end = shot["cut"]
    needed = end - start
    print(f"{shot['scene']} / {key}: cut=[{start},{end}) needs {needed} frames at {fps} fps")
    accepted = []
    pending = []
    for take in shot["takes"]:
        version = take["version"]
        target = f" replaces {key}/{take['replaces']}" if "replaces" in take else ""
        print(f"  {key}/{version}{target}: {take['status']}")
        if take["status"] == "accepted":
            accepted.append(take)
        elif take["status"] == "review":
            pending.append(version)
    if pending:
        print(f"  BLOCK {key}: pending review: {', '.join(pending)}")
    if len(accepted) != 1:
        versions = ", ".join(take["version"] for take in accepted)
        print(f"  BLOCK {key}: expected 1 accepted take, found {len(accepted)} ({versions or 'none'})")
        return False

    take = accepted[0]
    at = f"{key}/{take['version']}"
    try:
        file, first, last, count = placed_range(shot, take, folder, fps)
        print(f"  {at}: file={file} decoded={count} CFR={fps} "
              f"placed source=[{first},{last + 1}), tail handle={take['use'][1] - last - 1}")
    except (ValueError, OSError) as error:
        print(f"  BLOCK {at}: {error}")
        return False
    return not pending


def write_context(shots, fps, base, shot_id, version, output, action_frame=None):
    """Write a five-frame contact sheet. All source indices are zero-based."""
    import os
    import tempfile
    import textwrap

    try:
        from PIL import Image, ImageDraw, ImageFont
    except ImportError as error:
        raise ValueError("Pillow is required for --frames") from error
    output = Path(output).absolute()
    formats = {".jpg": "JPEG", ".jpeg": "JPEG", ".png": "PNG"}
    if output.suffix.lower() not in formats:
        raise ValueError("context output must be .jpg, .jpeg or .png")
    if output.exists() or output.is_symlink():
        raise ValueError(f"context output already exists: {output}")
    if not output.parent.is_dir():
        raise ValueError(f"missing context output directory: {output.parent}")

    tile_w, tile_h = 384, 216
    gap, top, bottom = 10, 72, 54
    canvas = Image.new("RGB", (5 * (tile_w + gap) + gap, tile_h + top + bottom), "#171a1e")
    draw = ImageDraw.Draw(canvas)

    def label_font(size):
        for name in ("segoeui.ttf", "DejaVuSans.ttf"):
            try:
                return ImageFont.truetype(name, size)
            except OSError:
                pass
        return ImageFont.load_default()

    title_font, small_font = label_font(18), label_font(15)
    notes = []

    def draw_cell(col, role, shot, take=None, frame=None, pixels=None, note=None):
        left = gap + col * (tile_w + gap)
        draw.rectangle((left, top, left + tile_w - 1, top + tile_h - 1), fill="#30363c")
        draw.text((left + 2, 7), role, fill="#d2d7db", font=title_font)
        if shot:
            key = shot["shot"] + ("/" + take["version"] if take else "")
            if take:
                key += "  [" + take["status"] + "]"
            draw.text((left + 2, 37), key, fill="white", font=title_font)
        if note:
            notes.append(f"{role}: {shot['shot'] + ': ' if shot else ''}{note}")
            summary = textwrap.wrap(" ".join(note.split()), width=39)
            if len(summary) > 5:
                summary = summary[:4] + [summary[4][:35] + " ..."]
            draw.multiline_text((left + 12, top + 30), "\n".join(summary),
                                fill="#e5e6e7", font=small_font, spacing=5)
            return
        canvas.paste(pixels, (left, top))
        timeline_frame = shot["cut"][0] + frame - take["use"][0]
        draw.text((left + 2, top + tile_h + 8),
                  f"source f{frame}  |  timeline f{timeline_frame}",
                  fill="#e5e6e7", font=small_font)

    def choose_take(shot, requested):
        takes = shot["takes"]
        if requested is not None:
            for take in takes:
                if take["version"] == requested:
                    return take
            raise ValueError(f"unknown version {requested!r}")
        accepted = [t for t in takes if t["status"] == "accepted"]
        if len(accepted) != 1:
            raise ValueError(f"expected one accepted take, found {len(accepted)}")
        if any(t["status"] == "review" for t in takes):
            raise ValueError("selection still under review; choose an explicit version for this shot")
        return accepted[0]

    def read_frames(source, indices):
        wanted = sorted(set(indices))
        select = "+".join(f"eq(n,{index})" for index in wanted)
        # Use display aspect (including sample aspect), then pad to a fixed tile.
        filters = (f"select='{select}',"
                   f"scale=w='max(1,round(min({tile_w},{tile_h}*dar)))':"
                   f"h='max(1,round(min({tile_h},{tile_w}/dar)))',"
                   f"setsar=1,format=rgb24,pad={tile_w}:{tile_h}:(ow-iw)/2:(oh-ih)/2")
        run = subprocess.run([
            "ffmpeg", "-nostdin", "-v", "error", "-protocol_whitelist", "file",
            "-i", str(source), "-map", "0:v:0", "-vf", filters,
            "-fps_mode", "passthrough", "-frames:v", str(len(wanted)),
            "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1",
        ], capture_output=True)
        stride = tile_h * tile_w * 3
        if run.returncode or run.stderr.strip() or len(run.stdout) != stride * len(wanted):
            detail = run.stderr.decode("utf-8", "replace").strip()
            raise ValueError("frame extraction failed: " + (detail or "incomplete frame data"))
        return {n: Image.frombytes("RGB", (tile_w, tile_h),
                                   run.stdout[j * stride:(j + 1) * stride])
                for j, n in enumerate(wanted)}

    ordered = list(shots)
    index = ordered.index(shot_id)
    current = shots[shot_id]
    try:
        take = choose_take(current, version)
        source, first, last, _ = placed_range(current, take, base, fps)
        if action_frame is None:
            middle = (first + last) // 2
            role = "MIDPOINT (unreviewed)"
        else:
            if type(action_frame) is not int or not first <= action_frame <= last:
                raise ValueError(f"action frame must be a source frame within [{first},{last}]")
            middle = action_frame
            role = "ACTION (specified frame)"
        frames = read_frames(source, [first, middle, last])
        for col, (label, frame) in enumerate((("CURRENT IN", first), (role, middle),
                                               ("CURRENT LAST", last)), start=1):
            draw_cell(col, label, current, take, frame, frames[frame])
    except (OSError, ValueError) as error:
        raise ValueError(f"{shot_id}: {error}") from error

    for offset, col, role in ((-1, 0, "PREVIOUS LAST"), (1, 4, "NEXT IN")):
        n = index + offset
        if not 0 <= n < len(ordered):
            draw_cell(col, role, None, note="No neighbour on this side of the supplied sheet.")
            continue
        neighbour = shots[ordered[n]]
        neighbour_take = None
        try:
            a, b = neighbour["cut"]
            c, d = current["cut"]
            if (offset < 0 and b != c) or (offset > 0 and a != d):
                raise ValueError(f"cuts [{a},{b}) and [{c},{d}) do not touch on this side")
            neighbour_take = choose_take(neighbour, None)
            source, first, last, _ = placed_range(neighbour, neighbour_take, base, fps)
            frame = last if offset < 0 else first
            pixels = read_frames(source, [frame])[frame]
            draw_cell(col, role, neighbour, neighbour_take, frame, pixels)
        except (OSError, ValueError) as error:
            draw_cell(col, role, neighbour, neighbour_take, note=str(error))

    # Stage on the destination volume and publish without replacing another writer.
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=output.parent, delete=False) as stream:
            temporary = Path(stream.name)
            canvas.save(stream, format=formats[output.suffix.lower()], quality=90)
        if os.name == "nt":
            temporary.rename(output)  # Windows refuses to replace an existing target.
        else:
            os.link(temporary, output)
    except OSError as error:
        raise ValueError(f"cannot write context image {output}: {error}") from error
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
    return notes


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("sheet", type=Path)
    parser.add_argument("--shot", help="check only this shot ID")
    parser.add_argument("--frames", type=Path, metavar="OUTPUT", help="write context frames for --shot")
    parser.add_argument("--version", help="show this version of the current shot in --frames")
    parser.add_argument("--action-frame", type=int, help="use this source-frame index for the action image")
    args = parser.parse_args()
    if args.frames is not None and args.shot is None:
        parser.error("--frames requires --shot")
    if args.frames is None and (args.version is not None or args.action_frame is not None):
        parser.error("--version and --action-frame require --frames")
    try:
        sheet = json.loads(args.sheet.read_text(encoding="utf-8-sig"))
        fps, shots = validate_shots(sheet)
        if args.shot is not None and args.shot not in shots:
            raise ValueError(f"unknown shot {args.shot!r}")
    except (ValueError, ZeroDivisionError, OSError) as error:
        print(f"INVALID {args.sheet}: {error}", file=sys.stderr)
        return 2

    selected = [shots[args.shot]] if args.shot is not None else shots.values()
    scope = f"shot {args.shot}" if args.shot is not None else "sheet"
    print(f"scope={scope} ({len(selected)}/{len(shots)} planned shots)")
    folder = args.sheet.absolute().parent
    passed = sum(check_shot(shot, folder, fps) for shot in selected)
    status = "PASS" if passed == len(selected) else "BLOCK"
    print(f"{status} {scope}: {passed}/{len(selected)} technical checks passed. "
          "Review action and continuity in the cut by eye.")
    if args.frames is not None:
        try:
            notes = write_context(shots, fps, folder, args.shot, args.version,
                                  args.frames, args.action_frame)
            print(f"Context image: {args.frames.absolute()}")
            for note in notes:
                print(f"  REVIEW {note}")
        except (RuntimeError, ValueError, OSError) as error:
            print(f"  BLOCK {args.shot} context: {error}")
            return 1
    return 0 if passed == len(selected) else 1


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    sys.exit(main())
