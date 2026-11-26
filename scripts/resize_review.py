#!/usr/bin/env python3
"""Find outputs using a changed storyboard state and compare its neighbouring transitions."""
import argparse
from contextlib import ExitStack
from fractions import Fraction
import html
import json
import math
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

import numpy as np
from PIL import Image
from takecheck import probe_video


def load(path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


def ids(values, label):
    if not isinstance(values, list) or not values or any(not isinstance(v, str) or not v for v in values):
        raise ValueError(f"{label}: expected nonempty text IDs")
    return values


def schedule(timing, n):
    fps = Fraction(str(timing["fps"]))
    holds, joins = timing["holds"], timing["joins"]
    if fps <= 0 or len(holds) != n or len(joins) != n - 1:
        raise ValueError("supply fps, one hold per board and one join per pair")
    if any(type(f) is not int or f < 0 for f in holds) or sorted(set(holds)) != holds:
        raise ValueError("holds must be increasing frame numbers")
    for i, bounds in enumerate(joins):
        if len(bounds) != 2 or any(type(f) is not int for f in bounds):
            raise ValueError("join must be a pair of frame numbers")
        if not holds[i] < bounds[0] < bounds[1] <= holds[i + 1]:
            raise ValueError("join must lie between its holds; use half-open frame ranges")
    wrap = timing.get("wrap")
    if wrap is not None and (len(wrap) != 2 or any(type(f) is not int for f in wrap)
                             or not holds[-1] < wrap[0] < wrap[1]):
        raise ValueError("wrap must be a final [start,end) transition after the last hold")
    return fps, holds, joins, wrap


def dependency_map(catalog, edges):
    nodes = {v for boards in catalog.values() for v in boards}
    for key, parents in edges.items():
        nodes.add(key)
        nodes.update(ids(parents, key))
    seen = {}

    def collect(key, chain):
        if key in chain:
            raise ValueError(f"circular dependency: {' -> '.join([*chain, key])}")
        if key not in seen:
            family = {key}
            for parent in edges.get(key, []):
                family.update(collect(parent, [*chain, key]))
            seen[key] = family
        return seen[key]
    for node in sorted(nodes):
        collect(node, [])
    return seen


def checkpoints(boards, targets, timing, control):
    fps, holds, joins, wrap = schedule(timing, len(boards))
    samples = {}

    def add(frame, role):
        samples.setdefault(frame, []).append(role)

    selected = set(targets)
    for i, board in enumerate(boards):
        if i in selected or control:
            add(holds[i], f"F{i+1} {board} · опорный кадр")
    all_joins = [(i, i + 1, limits) for i, limits in enumerate(joins)]
    if wrap is not None:
        all_joins.append((len(boards) - 1, 0, wrap))
    for left, right, (start, end) in all_joins:
        if not (control or left in selected or right in selected):
            continue
        # The midpoint alone misses the beginning/end of eased transitions.
        for phase in (0, .25, .5, .75, 1):
            frame = start + round((end - 1 - start) * phase)
            role = f"F{left+1} → F{right+1} · [{start},{end})"
            if role not in samples.get(frame, []):
                add(frame, role)
        for i in (left, right):
            if i not in selected and not control:
                title = f"F{i+1} {boards[i]} · соседний опорный кадр"
                if title not in samples.get(holds[i], []):
                    add(holds[i], title)
    neighbour_holds = {holds[i] for i in range(len(boards)) if i not in selected}
    return fps, [{"frame": f, "role": samples[f],
                  "scope": "control" if control else "neighbour" if f in neighbour_holds else "change"}
                 for f in sorted(samples)]


def plan(config, base, changed, controls):
    formats = config["formats"]
    if isinstance(formats, str):
        formats = load(base / formats)
    catalog = {row["key"]: ids(row["ids"], row["key"]) for row in formats}
    if not catalog or len(catalog) != len(formats):
        raise ValueError("format keys must be unique")
    tree = dependency_map(catalog, config.get("dependencies", {}))
    unknown = set(changed) - set(tree)
    if unknown:
        raise ValueError(f"unknown changed IDs: {sorted(unknown)}")
    impact = {key: [i for i, board in enumerate(boards) if set(changed) & tree[board]]
              for key, boards in catalog.items()}
    outputs = config["outputs"]
    names = ids([v["id"] for v in outputs], "output IDs")
    if len(set(names)) != len(names) or set(controls) - set(names):
        raise ValueError("duplicate output ID or unknown control")
    result = []
    packages = {}
    for entry in outputs:
        key, name = entry["format"], entry["id"]
        indices = impact[key]
        if indices:
            packages.setdefault(entry.get("deliverable", name), []).append(name)
        if name in controls and indices:
            raise ValueError(f"control {name} also depends on the change")
        if not indices and name not in controls:
            continue
        fps, samples = checkpoints(catalog[key], indices, entry.get("timing", config.get("timing")), name in controls)
        size = entry["size"]
        if len(size) != 2 or any(type(x) is not int or x < 1 for x in size):
            raise ValueError(f"{name}: invalid pixel dimensions")
        result.append({"id": name, "format": key, "deliverable": entry.get("deliverable", name),
                       "size": size, "fps": str(fps),
                       "control": name in controls, "samples": samples})
    affected = {k: [{"state": i+1, "board": catalog[k][i]} for i in val] for k, val in impact.items() if val}
    if not affected:
        raise ValueError("no board uses the requested sources")
    missing = sorted(set(affected) - {v["format"] for v in result})
    return {"changed": changed, "catalog_formats": len(catalog), "declared_outputs": len(outputs),
            "formats": affected, "rebuild": packages, "without_declared_output": missing, "outputs": result}


def html_frames(path, working, entry, output, frames, fps, stack, chrome):
    from playwright.sync_api import Error as BrowserError, sync_playwright
    if not chrome:
        playwright = stack.enter_context(sync_playwright())
        exe = os.getenv("CHROME_PATH") or shutil.which("google-chrome") or shutil.which("chromium")
        if not exe and os.name == "nt":
            for env in ("PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA"):
                candidate = Path(os.environ.get(env, "")) / "Google/Chrome/Application/chrome.exe"
                if candidate.is_file():
                    exe = str(candidate)
                    break
        chrome.append(playwright.chromium.launch(executable_path=exe))
        stack.callback(chrome[0].close)
    size = output["size"]
    page = chrome[0].new_page(viewport={"width": size[0], "height": size[1]}, device_scale_factor=1)
    try:
        errors = []
        page.on("pageerror", lambda err: errors.append(str(err)))
        def failed(response):
            if response.status >= 400:
                errors.append(f"{response.status} {response.url}")
        page.on("response", failed)
        page.on("requestfailed", lambda req: errors.append(f"{req.failure} {req.url}"))
        page.route("http://**/*", lambda route: route.abort())
        page.route("https://**/*", lambda route: route.abort())
        query = entry.get("query", "render")
        page.goto(path.as_uri() + ("?" + query if query else ""), wait_until="load")
        page.wait_for_function("window.__motion && typeof __motion.seek === 'function' && __motion.ready !== false")
        prop = entry.get("layoutProperty")
        if prop:
            active = page.evaluate("(p) => p.split('.').reduce((o,k)=>o?.[k], window)", prop)
            if active != output["format"]:
                raise ValueError(f"{output['id']}: runtime layout {active!r} != {output['format']!r}")
        rate, duration = page.evaluate("""async () => { const m=window.__motion; m.pause?.();
            await document.fonts.ready; return [m.fps, m.duration]; }""")
        if not math.isclose(rate, float(fps), rel_tol=1e-8) or not frames[-1] / float(fps) < duration:
            raise ValueError(f"{path.name}: clock {rate} fps / {duration} s does not cover requested frames")
        for f in frames:
            actual = page.evaluate("""async (t) => { const m=window.__motion, reached=await m.seek(t);
                await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
                const value = typeof m.time==='function' ? m.time() : m.time ?? reached;
                return Number.isFinite(value) ? value : null; }""", f / float(fps))
            if actual is None or not math.isfinite(actual) or abs(actual - f / float(fps)) > 1e-5:
                raise ValueError(f"{path.name}: __motion.seek did not reach frame {f}")
            page.screenshot(path=str(working / f"{f}.png"), timeout=15000)
        if errors:
            raise ValueError(f"{path.name}: {errors[0]}")
    except BrowserError as err:
        raise ValueError(f"{path.name}: {err}") from err
    finally:
        page.close()


def capture(path, working, entry, output, stack, chrome):
    if not path.is_file():
        raise ValueError(f"missing media: {path}")
    frames = [s["frame"] for s in output["samples"]]
    fps = Fraction(output["fps"])
    if path.suffix.lower() in (".html", ".htm"):
        html_frames(path, working, entry, output, frames, fps, stack, chrome)
        return
    total = probe_video(path, fps)
    if frames[-1] >= total:
        raise ValueError(f"{path.name}: frame {frames[-1]} outside {total} frames")
    select = "+".join(f"eq(n\\,{f})" for f in frames)
    cmd = ["ffmpeg", "-nostdin", "-v", "error", "-protocol_whitelist", "file", "-i", str(path),
           "-map", "0:v:0", "-vf", "select="+select, "-fps_mode", "passthrough", "-frames:v", str(len(frames)),
           "-threads:v", "1", "-start_number", "0", str(working / "decoded-%d.png")]
    subprocess.run(cmd, check=True)
    for i, frame in enumerate(frames):
        (working / f"decoded-{i}.png").rename(working / f"{frame}.png")


def measure(base, stage, config, report, threshold):
    outputs = {entry["id"]: entry for entry in config["outputs"]}
    chrome = []
    with ExitStack() as stack:
        for n, output in enumerate(report["outputs"]):
            entry = outputs[output["id"]]
            for version in ("before", "after"):
                folder = stage / f"{n}-{version}"
                folder.mkdir()
                path = (base / entry[version]).resolve()
                output[version] = str(path)
                capture(path, folder, entry, output, stack, chrome)
            for sample in output["samples"]:
                frame = sample["frame"]
                rasters = []
                for version in ("before", "after"):
                    rel = f"{n}-{version}/{frame}.png"
                    sample[version] = rel
                    with Image.open(stage / rel) as image:
                        if list(image.size) != output["size"]:
                            raise ValueError(f"{output['id']}: raster {image.size} != requested {output['size']}")
                        rasters.append(np.asarray(image.convert("RGB"), dtype=np.int16))
                delta = np.abs(rasters[0] - rasters[1])
                yy, xx = np.nonzero(delta.max(axis=2) > threshold)
                sample.update(mean_rgb=round(float(delta.mean()), 5), pixels=int(xx.size),
                              bbox=[int(xx.min()), int(yy.min()), int(xx.max()+1), int(yy.max()+1)] if xx.size else None)


def classify(report, minimum):
    flags = set()
    for out in report["outputs"]:
        found = False
        issues = set()
        for sample in out["samples"]:
            if sample["pixels"] < minimum:
                continue
            if out["control"]:
                issues.add("changed_control")
            elif sample["scope"] == "neighbour":
                issues.add("changed_neighbour")
            else:
                found = True
        if not out["control"] and not found:
            issues.add("no_visible_change")
        out["findings"] = sorted(issues)
        flags.update(issues)
    if report["without_declared_output"]:
        flags.add("missing_output")
    report["findings"] = sorted(flags)
    return "review" if flags else "sampled"


def html_report(report):
    def esc(value):
        return html.escape(str(value))
    body = ["<!doctype html><html lang=ru><meta charset=utf-8><title>Проверка ресайзов</title>",
            "<style>body{font:16px system-ui;max-width:1100px;margin:2rem auto;padding:0 1rem;color:#20242b}"
            "table{border-collapse:collapse;width:100%}td,th{text-align:left;padding:.5em;border-bottom:1px solid #ddd}"
            "img{width:180px;max-height:175px;object-fit:contain;background:#eee}</style>",
            "<h1>Проверка ресайзов</h1><p>Источники: " + esc(", ".join(report["changed"])) +
            " · <a href='review.json'>Измерения JSON</a></p>",
            f"<p>Раскладок в реестре: {report['catalog_formats']}. Затронуто: {len(report['formats'])}. "
            f"Выходов в манифесте: {report['declared_outputs']}. Статус: {esc(report['status'])}.</p>"]
    if report["without_declared_output"]:
        body.append("<p>Без указанного выхода: " + esc(", ".join(report["without_declared_output"])) + "</p>")
    body.append("<p>Пересобрать: " + esc(", ".join(report["rebuild"])) + "</p>")
    body.append("<p>Кадры приведены на шкале каждого выхода. Диапазоны [начало, конец) исключают правую границу. "
                f"Число пикселей учитывает изменения канала выше {report['pixel_threshold']}/255; "
                f"для замечания требуется минимум {report['min_pixels']} пикс. "
                "Нажмите на изображение для просмотра в размере доставки.</p>")
    for out in report["outputs"]:
        kind = "контроль" if out["control"] else "зависимый"
        body.append(f"<h2>{esc(out['id'])} · {kind}</h2><p>{out['size'][0]} × {out['size'][1]} · "
                    f"{esc(out['fps'])} fps.</p>")
        reasons = {"changed_control": "Изменился контрольный выход.", "changed_neighbour": "Изменился соседний опорный кадр.",
                   "no_visible_change": "В выборке ожидаемой правки не видно."}
        for flag in out.get("findings", []):
            body.append("<p>" + reasons[flag] + "</p>")
        body.append("<table><tr><th>Момент</th><th>До</th><th>После</th><th>Δ пикселей</th></tr>")
        for s in out["samples"]:
            images = "".join(f"<td><a href='{s[v]}'><img loading='lazy' src='{s[v]}' alt='{v} f{s['frame']}'></a></td>"
                             for v in ("before", "after")) if "pixels" in s else "<td>—</td><td>—</td>"
            body.append(f"<tr><td>f{s['frame']}<br>{esc(', '.join(s['role']))}</td>{images}<td>{s.get('pixels','—')}</td></tr>")
        body.append("</table>")
    return "\n".join(body) + "</html>\n"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path)
    parser.add_argument("--changed", action="append", required=True, metavar="ID")
    parser.add_argument("--control", action="append", default=[], metavar="OUTPUT_ID")
    parser.add_argument("--plan-only", action="store_true")
    parser.add_argument("--pixel-threshold", type=int, default=8, help="count max-channel changes above this value")
    parser.add_argument("--min-pixels", type=int, default=1, help="minimum changed pixels for a visible difference")
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    try:
        if not 0 <= args.pixel_threshold <= 254 or args.min_pixels < 1 or args.out.exists():
            raise ValueError("choose a new output directory, pixel threshold 0..254 and positive --min-pixels")
        config = load(args.manifest)
        report = plan(config, args.manifest.resolve().parent, args.changed, args.control)
        report["pixel_threshold"] = args.pixel_threshold
        report["min_pixels"] = args.min_pixels
        args.out.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=args.out.parent) as tmp:
            stage = Path(tmp) / "report"
            stage.mkdir()
            if args.plan_only:
                report["status"] = "plan"
            else:
                measure(args.manifest.resolve().parent, stage, config, report, args.pixel_threshold)
                report["status"] = classify(report, args.min_pixels)
            (stage / "review.json").write_text(json.dumps(report, ensure_ascii=False, indent=2)+"\n", encoding="utf8")
            (stage / "review.html").write_text(html_report(report), encoding="utf8")
            stage.rename(args.out)
        print(f"{report['status']}: {len(report['formats'])} affected formats; {args.out / 'review.html'}")
        return int(report["status"] == "review")
    except (KeyError, TypeError, ValueError, OSError, RuntimeError, subprocess.SubprocessError, ImportError) as ex:
        parser.exit(2, f"resize_review: {ex}\n")


if __name__ == "__main__":
    sys.exit(main())
