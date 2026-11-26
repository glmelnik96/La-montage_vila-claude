"""Learn a pacing and title profile from separate episodes, then measure an unseen export.

See references/series-profile.md for the episode manifest, provenance and frame clock.
"""

import argparse
import hashlib
import json
import math
import re
import subprocess
import sys
from pathlib import Path
from statistics import median

from video_reference import atomic_file, cut_candidates, measure, probe


def read(path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


def text_field(item, key):
    value = item.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"Expected nonempty {key}")
    return value.strip()


def frame(value, low, high):
    if type(value) is not int or not low <= value <= high:
        raise ValueError(f"Frame {value!r} is outside [{low}, {high}]")
    return value


def source_id(path):
    sha = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            sha.update(block)
    return sha.hexdigest()


def middle(values):
    return float(median(values)) if values else None


def words(text):
    return re.findall(r"[^\W_]+(?:[-’'][^\W_]+)*", text, flags=re.UNICODE)


def kind_name(kind):
    if not isinstance(kind, str) or not re.fullmatch(r"[a-z][a-z0-9_-]*", kind):
        raise ValueError(
            "kind must be a stable label such as subtitle, question or lower_third"
        )
    return kind


def title_metrics(cues, edges, scope, meta, complete, complete_kinds=()):
    start, end = scope
    groups = {}
    for cue in cues:
        kind = kind_name(cue.get("kind"))
        text_field(cue, "text")
        a = frame(cue["in"], start, end - 1)
        frame(cue["out"], a + 1, end)
        if "speechFrame" in cue:
            frame(cue["speechFrame"], 0, len(edges) - 2)
        if "box" in cue:
            box = cue["box"]
            if (
                not isinstance(box, list)
                or len(box) != 4
                or any(type(x) is not int for x in box)
            ):
                raise ValueError(
                    "Expected box [x,y,width,height] in displayed source pixels"
                )
            x, y, w, h = box
            if (
                min(x, y) < 0
                or min(w, h) <= 0
                or x + w > meta["width"]
                or y + h > meta["height"]
            ):
                raise ValueError(f"Title box outside displayed frame: {box}")
        groups.setdefault(kind, []).append(cue)
    metrics = {}
    support = {}
    for kind, rows in groups.items():
        intervals = sorted((c["in"], c["out"]) for c in rows)
        coverage = 0
        stop = start
        for a, b in intervals:
            if b > stop:
                coverage += edges[b] - edges[max(a, stop)]
                stop = b
        boxes = [c["box"] for c in rows if "box" in c]
        offsets = [
            float(edges[c["in"]] - edges[c["speechFrame"]])
            for c in rows
            if "speechFrame" in c
        ]
        prefix = f"title.{kind}."
        metrics.update(
            {
                prefix + "hold_s": middle(
                    [float(edges[b] - edges[a]) for a, b in intervals]
                ),
                prefix + "words": middle([len(words(c["text"])) for c in rows]),
                prefix + "coverage_pct": 100
                * float(coverage / (edges[end] - edges[start]))
                if complete or kind in complete_kinds
                else None,
                prefix + "center_y_pct": middle(
                    [100 * (y + h / 2) / meta["height"] for x, y, w, h in boxes]
                ),
                prefix + "width_pct": middle(
                    [100 * w / meta["width"] for x, y, w, h in boxes]
                ),
                prefix + "screen_minus_speech_s": middle(offsets),
            }
        )
        support[kind] = {
            "cues": len(rows),
            "boxes": len(boxes),
            "speechAnchors": len(offsets),
        }
    return metrics, support


def event_rates(events, start, end, duration):
    if not isinstance(events, dict):
        raise ValueError("events must be an object keyed by event kind")
    metrics = {}
    for kind, record in events.items():
        kind_name(kind)
        text_field(record, "evidence")
        frames = record["frames"]
        if not isinstance(frames, list):
            raise ValueError("Expected a list of observed event starts")
        for f in frames:
            frame(f, start, end - 1)
        if frames != sorted(set(frames)):
            raise ValueError("Event frames must be strictly increasing")
        metrics[f"event.{kind}.per_min"] = 60 * len(frames) / duration
    return metrics


def measure_episode(episode, manifest, threshold):
    ident = text_field(episode, "id")
    media = (manifest.parent / text_field(episode, "media")).resolve(strict=True)
    before = media.stat()
    meta, edges = probe(media)
    scope = episode.get("scope", [0, meta["frames"]])
    if not isinstance(scope, list) or len(scope) != 2:
        raise ValueError("scope must be [in,out)")
    start = frame(scope[0], 0, meta["frames"] - 1)
    end = frame(scope[1], start + 1, meta["frames"])
    title_list = episode.get("titles")
    if title_list is not None and not isinstance(title_list, list):
        raise ValueError("titles must be a list or null")
    if type(episode.get("titlesComplete", False)) is not bool:
        raise ValueError("titlesComplete must be true or false")
    complete = title_list is not None and episode.get("titlesComplete", False)
    complete_kinds = episode.get("completeTitleKinds", [])
    if not isinstance(complete_kinds, list) or len(
        set(map(kind_name, complete_kinds))
    ) != len(complete_kinds):
        raise ValueError("completeTitleKinds must list distinct title kinds")
    if title_list is None and (complete_kinds or episode.get("titlesComplete")):
        raise ValueError(
            "Explicitly supply titles (possibly []) when declaring coverage"
        )
    title_evidence = (
        text_field(episode, "titleEvidence") if title_list is not None else None
    )
    metrics, supports = title_metrics(
        title_list or [], edges, scope, meta, complete, complete_kinds
    )
    if "cutFrames" in episode:
        cuts = episode["cutFrames"]
        if not isinstance(cuts, list):
            raise ValueError("Expected list of edit points inside scope")
        for f in cuts:
            frame(f, start + 1, end - 1)
        if sorted(set(cuts)) != cuts:
            raise ValueError("cutFrames must be strictly increasing")
        basis = "editorial"
        cut_evidence = text_field(episode, "cutEvidence")
    else:
        scale = min(1, 240 / max(meta["width"], meta["height"]))
        scores = measure(
            media,
            max(1, round(meta["width"] * scale)),
            max(1, round(meta["height"] * scale)),
            {},
        )["frame"]
        if len(scores) != meta["frames"]:
            raise ValueError("Decoded proxy count differs from frame timestamps")
        cuts = [
            c["frame"]
            for c in cut_candidates(scores, threshold)
            if start < c["frame"] < end
        ]
        basis = "picture_candidates"
        cut_evidence = (
            f"RGB proxy, longest edge up to 240px, cut prominence {threshold:g}%"
        )
    boundaries = [start, *cuts, end]
    lengths = [float(edges[b] - edges[a]) for a, b in zip(boundaries, boundaries[1:])]
    duration = float(edges[end] - edges[start])
    events = episode.get("events", {})
    metrics.update(event_rates(events, start, end, duration))
    metrics.update(
        {
            "pace.cuts_per_min": 60 * len(cuts) / duration,
            "pace.shot_median_s": middle(lengths),
            "pace.first_cut_s": float(edges[cuts[0]] - edges[start]) if cuts else None,
        }
    )
    digest = source_id(media)
    after = media.stat()
    if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
        raise ValueError("Source changed during measurement")
    return {
        "id": ident,
        "media": str(media),
        "sha256": digest,
        "video": meta,
        "scope": scope,
        "seconds": duration,
        "cutBasis": basis,
        "cutEvidence": cut_evidence,
        "cuts": cuts,
        "titles": title_list,
        "titlesComplete": complete,
        "completeTitleKinds": complete_kinds,
        "titleEvidence": title_evidence,
        "titleSupport": supports,
        "events": events,
        "metrics": metrics,
    }


def confirmed_absent(episode, key):
    if not key.startswith("title."):
        return False
    kind = key.split(".")[1]
    return (
        episode["titlesComplete"] or kind in episode.get("completeTitleKinds", [])
    ) and kind not in episode["titleSupport"]


def metric_value(episode, key):
    value = episode["metrics"].get(key)
    if value is None and key.startswith("title.") and key.endswith(".coverage_pct"):
        if confirmed_absent(episode, key):
            return 0.0
    return value


def learn(name, episodes, threshold):
    if len(episodes) < 3:
        raise ValueError("Provide at least three distinct reference episodes")
    for field in ("id", "sha256"):
        if len({e[field] for e in episodes}) != len(episodes):
            raise ValueError(f"Training episodes repeat {field}")
    if len({e["cutBasis"] for e in episodes}) != 1:
        raise ValueError("Use the same basis for cut counts in all references")
    bands = {}
    for key in sorted(set().union(*(e["metrics"] for e in episodes))):
        values = [v for e in episodes if (v := metric_value(e, key)) is not None]
        bands[key] = {
            "episodes": len(values),
            "low": min(values, default=None),
            "median": middle(values),
            "high": max(values, default=None),
        }
    return {
        "schema": "series-profile/1",
        "series": name,
        "cutThreshold": threshold,
        "bands": bands,
        "references": episodes,
    }


def compare(profile, episode):
    if profile.get("schema") != "series-profile/1":
        raise ValueError("Unsupported series profile")
    if any(
        episode["sha256"] == e["sha256"] or episode["id"] == e["id"]
        for e in profile["references"]
    ):
        raise ValueError("The check episode is already in the reference set")
    out = {}
    for key in sorted(profile["bands"].keys() | episode["metrics"].keys()):
        band = profile["bands"].get(key)
        val = metric_value(episode, key)
        if val is None:
            status = "kind_absent" if confirmed_absent(episode, key) else "not_observed"
        elif band is None or band["episodes"] < 3:
            status = "no_reference"
        elif (
            key.startswith("pace.")
            and profile["references"][0]["cutBasis"] != episode["cutBasis"]
        ):
            status = "different_cut_basis"
        else:
            status = "inside" if band["low"] <= val <= band["high"] else "outside"
        out[key] = {"value": val, "band": band, "status": status}
    return out


METRICS = {
    "cuts_per_min": "Склеек в минуту",
    "shot_median_s": "Медиана длины плана, с",
    "first_cut_s": "До первой склейки, с",
    "hold_s": "Медиана длительности титра, с",
    "words": "Медиана числа слов",
    "coverage_pct": "Доля времени на экране, %",
    "center_y_pct": "Центр текста по высоте, %",
    "width_pct": "Ширина текста, %",
    "screen_minus_speech_s": "Начало титра минус начало слова, с",
    "per_min": "Событий в минуту",
}
STATUS = {
    "inside": "В диапазоне",
    "outside": "За пределами диапазона",
    "not_observed": "Нет измерения",
    "kind_absent": "Тип титра отсутствует",
    "no_reference": "Меньше трёх эталонов",
    "different_cut_basis": "Разные способы подсчёта склеек",
}


def report_table(name, rows):
    lines = [
        f"# {name}",
        "",
        "| Параметр | Эталоны | Диапазон | Медиана | Проверяемый выпуск |",
        "|---|---:|---:|---:|---|",
    ]
    for key, band, result in rows:
        parts = key.split(".")
        label = METRICS[parts[-1]]
        if len(parts) == 3:
            label = f"{parts[1]} · {label}"
        span = mid = "—"
        if band and band["episodes"]:
            span = f"{band['low']:.3f}…{band['high']:.3f}"
            mid = f"{band['median']:.3f}"
        checked = "—"
        if result:
            checked = STATUS[result["status"]]
            if result["value"] is not None:
                checked = f"{result['value']:.3f} · {checked}"
        lines.append(
            f"| {label} | {band['episodes'] if band else 0} | {span} | {mid} | {checked} |"
        )
    lines += [
        "",
        "Диапазон — минимум и максимум по выпускам. У каждого выпуска один голос.",
        "Выход за границу направляет на просмотр. Основание разметки, число наблюдений и кадры есть в JSON.",
    ]
    return "\n".join(lines) + "\n"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    subs = parser.add_subparsers(dest="command", required=True)
    for action in ("learn", "check", "measure"):
        sub = subs.add_parser(action)
        if action == "check":
            sub.add_argument("profile", type=Path)
        else:
            sub.add_argument("--cut-threshold", type=float, default=10.0)
        sub.add_argument("manifest", type=Path)
        sub.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    spec = read(args.manifest)
    profile = read(args.profile) if args.command == "check" else None
    threshold = profile["cutThreshold"] if profile else args.cut_threshold
    if not math.isfinite(threshold) or not 0 < threshold <= 100:
        raise ValueError("Expected --cut-threshold > 0 and <= 100")
    if args.command == "learn":
        rows = spec["episodes"]
        if not isinstance(rows, list) or len(rows) < 3:
            raise ValueError("Provide at least three reference episodes")
        result = learn(
            text_field(spec, "series"),
            [measure_episode(e, args.manifest, threshold) for e in rows],
            threshold,
        )
        filename = "style.json"
        summary = report_table(
            result["series"],
            [(key, band, None) for key, band in result["bands"].items()],
        )
    else:
        episode = measure_episode(spec, args.manifest, threshold)
        if args.command == "check":
            result = {
                "series": profile["series"],
                "episode": episode,
                "comparison": compare(profile, episode),
            }
            filename = "comparison.json"
            summary = report_table(
                f"{profile['series']} · {episode['id']}",
                [(key, row["band"], row) for key, row in result["comparison"].items()],
            )
        else:
            result, filename = episode, "measurement.json"
            summary = None
    args.out.mkdir(parents=True, exist_ok=True)
    target = args.out / filename
    if target.resolve() == args.manifest.resolve():
        raise ValueError("Choose an output separate from the input manifest")
    atomic_file(
        target,
        (
            json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False) + "\n"
        ).encode("utf-8"),
    )
    if summary:
        atomic_file(target.with_suffix(".md"), summary.encode("utf-8"))
    print(filename)


if __name__ == "__main__":
    try:
        main()
    except (
        ValueError,
        KeyError,
        TypeError,
        OSError,
        subprocess.CalledProcessError,
    ) as error:
        sys.exit(f"series_profile: {error}")
