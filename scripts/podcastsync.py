"""Offline scratch-to-recorder sync. See references/multicam-sync.md."""
import argparse
from dataclasses import dataclass
from fractions import Fraction
import json
import math
import os
from pathlib import Path
import subprocess
import tempfile

import numpy as np
from scipy.fft import rfft, irfft, next_fast_len
from scipy.signal.windows import tukey
from scipy.stats import theilslopes


RATE = 8000
HOP = 80                         # 100 energy measurements/second
REPORT = "podcastsync-v1"


@dataclass
class Audio:
    item: dict
    pcm: np.ndarray
    envelope: np.ndarray

    @property
    def duration(self):
        return len(self.pcm) / RATE


def make_envelope(pcm):
    # Read the file-backed signal in blocks; retain only its 100 Hz envelope.
    blocks = []
    count = len(pcm) // HOP
    for start in range(0, count, 8192):
        end = min(count, start + 8192)
        part = pcm[start * HOP:end * HOP].astype(np.float32).reshape(-1, HOP)
        blocks.append(np.mean(part * part, axis=1))
    if not blocks:
        return np.empty(0)
    energy = np.concatenate(blocks)
    if np.percentile(energy, 95) < 4 and energy.max() < 64:
        return np.empty(0)
    level = np.log(np.maximum(energy, 1))
    width = min(201, len(level) // 2 * 2 + 1)
    smooth = np.convolve(np.pad(level, width // 2, mode="edge"), np.ones(width) / width, mode="valid")
    return level - smooth


def decode(item, scratch):
    # A raw scratch file keeps a multi-hour take out of the Python heap.
    filters = []
    if "channel" in item:
        filters.append(f"pan=mono|c0=c{item['channel']}")
    filters.extend(["highpass=f=160", "lowpass=f=3400"])
    args = ["ffmpeg", "-nostdin", "-v", "error", "-i", str(item["file"]),
            "-map", f"0:a:{item.get('stream', 0)}", "-vn", "-af", ",".join(filters),
            "-ac", "1", "-ar", str(RATE), "-f", "s16le", "-y", str(scratch)]
    result = subprocess.run(args, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    if result.returncode or not scratch.exists() or scratch.stat().st_size < 2:
        reason = result.stderr.decode("utf-8", "replace").strip()
        raise ValueError(reason or "empty decoded audio")
    pcm = np.memmap(scratch, mode="r", dtype="<i2")
    return Audio(item, pcm, make_envelope(pcm))


def coarse_peaks(a, b):
    small = min(len(a), len(b))
    if small < 100:
        return []
    required = min(1500, max(100, int(.70 * small)))
    n = next_fast_len(len(a) + len(b))
    lags = np.arange(required - len(a), len(b) - required + 1)
    i = np.maximum(0, -lags)
    j = np.minimum(len(a), len(b) - lags)
    ca = np.r_[0., np.cumsum(a * a)]
    cb = np.r_[0., np.cumsum(b * b)]
    numerator = irfft(rfft(a, n).conj() * rfft(b, n), n)[lags % n]
    denominator = np.sqrt(np.maximum(0, (ca[j] - ca[i]) * (cb[j + lags] - cb[i + lags])))
    scores = np.divide(numerator, denominator, out=np.zeros_like(numerator), where=denominator > 1e-6)
    peaks = []
    for _ in range(3):
        pos = int(np.argmax(scores))
        if scores[pos] < .15:
            break
        peaks.append((float(lags[pos]) / 100, float(scores[pos])))
        scores[np.abs(lags - lags[pos]) < 50] = -1.
    return peaks


def fine_match(a, b):
    # Valid GCC-PHAT lags: a fits completely inside b.
    if min(np.std(a), np.std(b)) < 3:
        return None
    n = next_fast_len(len(a) + len(b))
    spectrum = rfft(a * tukey(len(a), .15), n).conj() * rfft(b, n)
    freq = np.fft.rfftfreq(n, 1 / RATE)
    spectrum /= np.maximum(abs(spectrum), 1e-10)
    spectrum[(freq < 200) | (freq > 3200)] = 0
    values = abs(irfft(spectrum, n)[:len(b) - len(a) + 1])
    peak = int(np.argmax(values))
    side = values[abs(np.arange(len(values)) - peak) > .006 * RATE]
    if len(side) == 0:
        return None
    return peak, float(values[peak]), float(values[peak] / max(1e-8, side.max()))


def refine(camera, take, lag, coarse, window_seconds=4.):
    start = max(0., -lag)
    end = min(camera.duration, take.duration - lag)
    overlap = end - start
    win = min(window_seconds, overlap / 2)
    count = max(1, min(13, int(overlap / max(win, 1))))
    size = round(win * RATE)
    rows = []
    # Extra search room permits moderate clock drift over a long recording.
    margin = round((.18 + .0015 * overlap) * RATE)
    for when in np.linspace(start, end - win, count):
        s = round(when * RATE)
        predicted = s + round(lag * RATE)
        low = max(0, predicted - margin)
        high = min(len(take.pcm), predicted + size + margin)
        if high - low < size + 2 or s + size > len(camera.pcm):
            continue
        match = fine_match(camera.pcm[s:s + size], take.pcm[low:high])
        if match is None:
            continue
        pos, peak, ratio = match
        if peak >= .025 and ratio >= 1.45:
            rows.append(((s + size / 2) / RATE, (low + pos - s) / RATE, ratio))
    base = {"coarseOffsetSec": round(lag, 4), "envelopeNcc": round(coarse, 4), "windowSec": round(win, 4),
            "windowsChecked": count, "agreeingWindows": 0}
    if not rows:
        return base
    x, y, psr = np.array(rows).T
    slopes = [(y[j] - y[i]) / (x[j] - x[i]) for i in range(len(x)) for j in range(i+1, len(x))
              if x[j] > x[i]]
    slope = float(np.median(slopes)) if slopes else 0.
    intercept = float(np.median(y - slope * x))
    keep = abs(y - (intercept + slope * x)) <= .008
    if not np.any(keep):
        return base
    x, y, psr = x[keep], y[keep], psr[keep]
    # Speech from different microphones/speakers can jump several milliseconds.
    # Require a stable slope before reporting a clock estimate.
    drift = False
    slope, intercept = 0., float(np.median(y))
    if len(x) >= 3 and np.ptp(x) >= 10:
        estimate = theilslopes(y, x, alpha=.95)
        base["driftIntervalPpm"] = [round(float(v) * 1e6, 3) for v in (estimate.low_slope, estimate.high_slope)]
        base["estimatedDriftPpm"] = round(float(estimate.slope) * 1e6, 3)
        drift = (estimate.high_slope - estimate.low_slope) <= max(.000025, abs(estimate.slope) * .5)
        if drift:
            slope = float(estimate.slope)
            intercept = float(np.median(y - slope * x))
    residual = float(np.max(abs(y - (intercept + slope * x))))
    verified = (len(x) >= min(2, count) and len(x) >= count / 2 and abs(slope) <= .002 and residual <= .008
                and (len(x) > 1 or (coarse >= .5 and psr[0] >= 2)))
    base.update(verified=bool(verified), agreeingWindows=len(x), windowSpanSec=round(float(np.ptp(x)), 3),
                guideOffsetSec=round(float(intercept), 6), driftPpm=round(float(slope * 1e6), 3) if drift else None,
                medianPeakToSidelobe=round(float(np.median(psr)), 3),
                maxResidualMs=round(residual * 1000, 3),
                windows=[{"guideTimeSec": round(float(t), 4), "offsetSec": round(float(o), 6)} for t, o in zip(x, y)])
    return base


def check_peak(camera, take, lag, score):
    result = refine(camera, take, lag, score)
    overlap = min(camera.duration, take.duration - lag) - max(0., -lag)
    # A room microphone dominated by ambience can need longer speech excerpts.
    if not result.get("verified") and score >= .45 and overlap >= 24:
        longer = refine(camera, take, lag, score, window_seconds=8.)
        if longer.get("verified"):
            return longer
    return result


def rank(candidate):
    return (candidate.get("verified", False), candidate["agreeingWindows"], candidate["envelopeNcc"])


def sync_camera(camera, refs, failed_refs, fps):
    item = camera.item
    result = {"id": item["id"], "durationSec": round(camera.duration, 6), "pairs": []}
    possible = []
    for rid, take in refs.items():
        peaks = coarse_peaks(camera.envelope, take.envelope)
        candidates = sorted([check_peak(camera, take, lag, score) for lag, score in peaks], key=rank, reverse=True)
        confirmed = []
        for c in candidates:
            if "guideOffsetSec" in c:
                rate = 1 + (c["driftPpm"] or 0) / 1e6
                c["offsetSec"] = round(c["guideOffsetSec"] + take.item.get("audioStartSec", 0)
                                       - rate * item.get("audioStartSec", 0), 6)
            if c.get("verified") and all(abs(c["guideOffsetSec"] - v["guideOffsetSec"]) > .02 for v in confirmed):
                confirmed.append(c)
                possible.append((take, c))
        status = "ambiguous" if len(confirmed) > 1 else ("matched" if confirmed else "unconfirmed")
        pair = {"take": rid, "status": status, "candidates": candidates}
        if not confirmed:
            if not len(camera.envelope) or not len(take.envelope):
                pair["reason"] = "silent_or_empty_audio"
            elif not peaks:
                pair["reason"] = "no_coarse_peak_or_insufficient_overlap"
            else:
                pair["reason"] = "insufficient_agreeing_waveform_windows"
        result["pairs"].append(pair)
    for rid, reason in failed_refs.items():
        result["pairs"].append({"take": rid, "status": "unavailable", "error": reason})
    if len(possible) != 1 or failed_refs:
        result["status"] = "ambiguous" if len(possible) > 1 else ("incomplete" if failed_refs else "unconfirmed")
        return result
    take, c = possible[0]
    offset = c["offsetSec"]
    result.update(status="matched", take=take.item["id"], offsetSec=offset,
                  driftPpm=c["driftPpm"], evidence={"envelopeNcc": c["envelopeNcc"],
                  "medianPeakToSidelobe": c["medianPeakToSidelobe"], "agreeingWindows": c["agreeingWindows"],
                  "windowsChecked": c["windowsChecked"], "maxResidualMs": c["maxResidualMs"]})
    if c["driftPpm"] is not None:
        result["driftAcrossGuideMs"] = round(c["driftPpm"] * camera.duration / 1000, 3)
    if "timelineStartSec" in take.item:
        exact = take.item["timelineStartSec"] + offset
        frame = math.floor(exact * float(fps) + .5)
        result["placement"] = {"timelineSec": round(exact, 6), "frame": frame,
                               "roundingMs": round((frame / float(fps) - exact) * 1000, 3)}
    return result


def read_manifest(path):
    data = json.loads(path.read_text(encoding="utf-8-sig"))
    fps = Fraction(str(data["fps"]))
    if fps <= 0:
        raise ValueError("fps must be positive")
    for group in ("takes", "cameras"):
        items = data[group]
        if not isinstance(items, list) or not items:
            raise ValueError(f"{group}: expected a non-empty list")
        ids = set()
        for item in items:
            if not isinstance(item, dict) or not isinstance(item.get("id"), str) or not item["id"].strip() or item["id"] in ids:
                raise ValueError(f"{group}: expected a unique, non-empty id")
            ids.add(item["id"])
            if not isinstance(item.get("file"), str) or not item["file"].strip():
                raise ValueError(f"{group}/{item['id']}: file path is required")
            item["file"] = (path.parent / item["file"]).resolve()
            for key in ("audioStartSec", "timelineStartSec"):
                if key in item and (type(item[key]) not in (float, int) or not math.isfinite(item[key])):
                    raise ValueError(f"{key} must be finite seconds")
            for key in ("channel", "stream"):
                if key in item and (type(item[key]) is not int or item[key] < 0):
                    raise ValueError(f"{key} must be a non-negative integer")
            if "clockGroup" in item or "timecodeSec" in item:
                if (group != "cameras" or not isinstance(item.get("clockGroup"), str)
                        or not item["clockGroup"].strip() or type(item.get("timecodeSec")) not in (int, float)
                        or not math.isfinite(item["timecodeSec"])):
                    raise ValueError("camera clock hints require a clockGroup and finite timecodeSec")
    return data, fps


def timecode_hints(rows, items, refs, fps, folder):
    """Use only independently matched cameras from the same free-running clock."""
    metadata = {i["id"]: i for i in items}
    anchors = {}
    for row in rows:
        item = metadata[row["id"]]
        if item.get("clockGroup") and row["status"] == "matched" and row["durationSec"] > 100:
            quality = row["evidence"]
            if quality["agreeingWindows"] >= max(3, .7 * quality["windowsChecked"]):
                anchors.setdefault(item["clockGroup"], []).append(row)
    for row in rows:
        item = metadata[row["id"]]
        group = item.get("clockGroup")
        if row["status"] != "unconfirmed" or group not in anchors:
            continue
        anchor = min(anchors[group], key=lambda a: abs(metadata[a["id"]]["timecodeSec"] - item["timecodeSec"]))
        delta = item["timecodeSec"] - metadata[anchor["id"]]["timecodeSec"]
        offset = anchor["offsetSec"] + delta
        take = refs[anchor["take"]]
        hint = {"clockGroup": group, "anchor": anchor["id"], "take": anchor["take"],
                "anchorOffsetSec": anchor["offsetSec"], "timecodeDeltaSec": round(delta, 6),
                "suggestedOffsetSec": round(offset, 6)}
        row["timecodeHint"] = hint
        if "timelineStartSec" in take.item:
            hint["suggestedFrame"] = math.floor((take.item["timelineStartSec"] + offset) * float(fps) + .5)
        predicted = offset + item.get("audioStartSec", 0) - take.item.get("audioStartSec", 0)
        start, end = max(0., -predicted), min(row["durationSec"], take.duration - predicted)
        if end - start < 1:
            hint["check"] = "no_audio_overlap" if end <= start else "insufficient_overlap"
            continue
        # Local search around a predicted position is corroboration only: it cannot
        # independently select the recorder or disambiguate repeated dialogue.
        try:
            camera = decode(item, folder / "hint.pcm")
        except ValueError as exc:
            hint.update(check="read_error", error=str(exc))
            continue
        windows = []
        try:
            win = min(20., end - start)
            count = max(1, min(5, int((end - start) / win)))
            for when in np.linspace(start, end - win, count):
                s, size = round(when * RATE), round(win * RATE)
                center = s + round(predicted * RATE)
                low, high = max(0, center - round(1.2 * RATE)), min(len(take.pcm), center + size + round(1.2 * RATE))
                if high - low <= size or s + size > len(camera.pcm):
                    continue
                hit = fine_match(camera.pcm[s:s + size], take.pcm[low:high])
                if hit and hit[1] >= .025 and hit[2] >= 1.45:
                    source_offset = (low + hit[0] - s) / RATE + take.item.get("audioStartSec", 0) - item.get("audioStartSec", 0)
                    windows.append({"guideTimeSec": round((s + size / 2) / RATE, 4),
                                    "offsetSec": round(source_offset, 6), "peakToSidelobe": round(hit[2], 3)})
            hint.update(check="local_audio_peak" if windows else "no_clear_local_peak",
                        windowsChecked=count, localWindows=windows)
        finally:
            camera.pcm._mmap.close()


def analyze(data, fps):
    with tempfile.TemporaryDirectory(prefix="podcastsync-") as temp:
        folder = Path(temp)
        refs = {}
        failed_refs = {}
        rows = []
        try:
            for index, item in enumerate(data["takes"]):
                try:
                    refs[item["id"]] = decode(item, folder / f"rec{index}.pcm")
                except ValueError as e:
                    failed_refs[item["id"]] = str(e)
            for item in data["cameras"]:
                try:
                    camera = decode(item, folder / "camera.pcm")
                except ValueError as e:
                    rows.append({"id": item["id"], "status": "unavailable", "error": str(e),
                                 "pairs": [{"take": t["id"], "status": "unavailable", "reason": "camera_unavailable"}
                                           for t in data["takes"]]})
                    continue
                try:
                    rows.append(sync_camera(camera, refs, failed_refs, fps))
                finally:
                    camera.pcm._mmap.close()
            timecode_hints(rows, data["cameras"], refs, fps, folder)
        finally:
            for take in refs.values():
                take.pcm._mmap.close()
    return {"format": REPORT, "fps": str(fps), "cameras": rows, "unavailableTakes": failed_refs}


def report_md(report):
    statuses = {"matched": "подтверждено", "ambiguous": "несколько совпадений", "incomplete": "не все дубли доступны",
                "unavailable": "файл недоступен", "unconfirmed": "не подтверждено"}
    lines = ["# Синхронизация камер и рекордера", "",
             f"Частота секвенции: {report['fps']} fps. Offset — время нулевого кадра камеры в источнике рекордера. "
             "Положительный drift означает, что время рекордера растёт быстрее относительно камеры.",
             "", "| Камера | Статус | Дубль | Offset, с | Кадр секвенции | Drift, ppm | Окна | NCC | PSR |",
             "|---|---|---|---:|---:|---:|---:|---:|---:|"]
    def cell(value):
        return str(value).replace("|", "\\|").replace("\n", " ")
    for row in report["cameras"]:
        e = row.get("evidence", {})
        fields = [row["id"], statuses[row["status"]], row.get("take", "—"),
                  f'{row["offsetSec"]:+.6f}' if "offsetSec" in row else "—",
                  row.get("placement", {}).get("frame", "—"), row.get("driftPpm"),
                  f"{e['agreeingWindows']}/{e['windowsChecked']}" if e else "—",
                  e.get("envelopeNcc", "—"), e.get("medianPeakToSidelobe", "—")]
        lines.append("| " + " | ".join(cell(v) if v is not None else "—" for v in fields) + " |")
    lines.extend(["", "«Окна» — согласованные позиции / проверенные окна. NCC — корреляция огибающих, "
                  "PSR — медианное отношение основного пика к боковому в согласованных окнах."])
    unresolved = [row for row in report["cameras"] if row["status"] != "matched"]
    if unresolved:
        lines.extend(["", "## Что проверить вручную", ""])
    for row in unresolved:
        pairs = row.get("pairs", [])
        if row["status"] == "unavailable":
            detail = cell(row["error"])
        else:
            notes = []
            for pair in pairs:
                verified = [c for c in pair.get("candidates", []) if c.get("verified")]
                if verified:
                    offsets = ", ".join(f'{c["offsetSec"]:+.4f} с' for c in verified)
                    notes.append(f'{pair["take"]} ({offsets})')
                elif pair["status"] == "unavailable":
                    notes.append(f'{pair["take"]} — ошибка чтения')
            detail = ", ".join(notes)
            if not detail:
                if any(p.get("reason") == "silent_or_empty_audio" for p in pairs):
                    detail = "тишина или пустая дорожка при сравнении"
                else:
                    detail = "ни один дубль не дал устойчивого совпадения"
                candidates = [(p["take"], c) for p in pairs for c in p.get("candidates", []) if c["agreeingWindows"]]
                if candidates:
                    take, c = max(candidates, key=lambda pair: rank(pair[1]))
                    detail += (f'; возможный дубль {take}, {c["agreeingWindows"]}/{c["windowsChecked"]} окон, '
                               f'NCC {c["envelopeNcc"]}')
        lines.append(f'- {cell(row["id"])} — {detail}.')
    hints = [row for row in unresolved if "timecodeHint" in row]
    if hints:
        lines.extend(["", "## Предложения по таймкоду для ручной проверки", "",
                      "Позиция рассчитана от подтверждённой записи той же камеры. Локальный поиск звука ограничен ±1,2 с от прогноза.",
                      "", "| Камера | Опорная запись | Дубль | Прогноз offset, с | Кадр по TC | Локальная проверка |",
                      "|---|---|---|---:|---:|---|"])
    for row in hints:
        h = row["timecodeHint"]
        check = {"no_audio_overlap": "без звукового пересечения", "insufficient_overlap": "пересечение короче секунды",
                 "no_clear_local_peak": "нет ясного пика", "read_error": "ошибка чтения"}.get(h["check"])
        if h["check"] == "local_audio_peak":
            check = ", ".join(f'{w["offsetSec"]:+.5f} с (PSR {w["peakToSidelobe"]:.2f})' for w in h["localWindows"])
        fields = [row["id"], h["anchor"], h["take"], f'{h["suggestedOffsetSec"]:+.6f}', h.get("suggestedFrame", "—"), check]
        lines.append("| " + " | ".join(cell(v) for v in fields) + " |")
    lines.extend(["", "Все пары, локальные смещения и ошибки чтения доступны в [podcastsync.json](podcastsync.json)."])
    return "\n".join(lines) + "\n"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path)
    parser.add_argument("--out", required=True, type=Path, help="directory for podcastsync.json and podcastsync.md")
    args = parser.parse_args()
    try:
        data, fps = read_manifest(args.manifest)
        out = args.out
        outputs = [out / "podcastsync.json", out / "podcastsync.md"]
        inputs = {args.manifest.resolve(), *(x["file"] for bucket in ("cameras", "takes") for x in data[bucket])}
        if any(p.resolve() in inputs for p in outputs):
            raise ValueError("output would overwrite an input")
        out.mkdir(parents=True, exist_ok=True)
        if any(p.exists() for p in outputs):
            if not outputs[0].is_file() or json.loads(outputs[0].read_text(encoding="utf-8")).get("format") != REPORT:
                raise ValueError("output collides with an unrelated file; choose a fresh directory")
        report = analyze(data, fps)
        with tempfile.TemporaryDirectory(prefix=".podcastsync-", dir=out) as stage:
            contents = [json.dumps(report, indent=2, ensure_ascii=False, allow_nan=False) + "\n", report_md(report)]
            for dest, content in zip(outputs, contents):
                (Path(stage) / dest.name).write_text(content, encoding="utf-8")
            for dest in reversed(outputs):
                os.replace(Path(stage) / dest.name, dest)
        matched = sum(c["status"] == "matched" for c in report["cameras"])
        print(f"{matched}/{len(report['cameras'])} matched: {outputs[0]}")
        return 0 if matched == len(report["cameras"]) else 1
    except (OSError, ValueError, KeyError, TypeError, ZeroDivisionError) as e:
        parser.exit(2, f"podcastsync: {e}\n")


if __name__ == "__main__":
    raise SystemExit(main())
