"""Review a marked gameplay event through delivery crops. See references/gameplay-review.md."""
import argparse
from bisect import bisect_right
import html
import json
import math
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image
from video_reference import probe, proxy_frames


def numbers(value, count, label):
    if not isinstance(value, list) or len(value) != count or any(type(x) is not int for x in value):
        raise ValueError(f"{label}: expected {count} integers")
    return value


def size(value, label):
    w, h = numbers(value, 2, label)
    if min(w, h) <= 0:
        raise ValueError(f"{label}: expected a positive size")
    return w, h


def rect(value, bounds, label):
    x, y, w, h = numbers(value, 4, label)
    if min(x, y) < 0 or min(w, h) <= 0 or x + w > bounds[0] or y + h > bounds[1]:
        raise ValueError(f"{label}: rectangle outside {bounds}")
    return value


def label(record, key):
    value = record[key]
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{key}: expected text")
    return value


def validate(spec, media):
    label(spec, "event")
    start, end = numbers(spec["range"], 2, "range")
    if not 0 <= start < end <= media["frames"]:
        raise ValueError("range must be a non-empty source interval [in,out)")
    bounds = media["width"], media["height"]
    beats = spec["beats"]
    if not isinstance(beats, list):
        raise ValueError("beats must be a list")
    phases = [b["phase"] for b in beats]
    groups = [v for i, v in enumerate(phases) if i == 0 or v != phases[i-1]]
    if groups != ["before", "action", "response"]:
        raise ValueError("mark before, action and response in order")
    prev = start - 1
    for beat in beats:
        f = beat["frame"]
        if type(f) is not int or not prev < f < end:
            raise ValueError("beat frames must be chronological and inside range")
        prev = f
        label(beat, "observed")
        if not isinstance(beat["regions"], list) or not beat["regions"]:
            raise ValueError("mark the visible evidence at every beat")
        names = set()
        for r in beat["regions"]:
            name = label(r, "name")
            if name in names:
                raise ValueError("duplicate region name within one beat")
            names.add(name)
            rect(r["box"], bounds, name)
            if "minSize" in r:
                size(r["minSize"], name)
    layouts = spec["layouts"]
    if not isinstance(layouts, list) or not layouts:
        raise ValueError("supply at least one delivery layout")
    names = set()
    for layout in layouts:
        name = label(layout, "name")
        if "reviewed" in layout:
            label(layout, "reviewed")
        if name in names:
            raise ValueError("duplicate delivery name")
        names.add(name)
        w, h = size(layout["size"], name)
        if w % 2 or h % 2:
            raise ValueError("H.264 delivery dimensions must be even")
        crop = rect(layout["crop"], bounds, name)
        keys = layout.get("cropKeys", [])
        if not isinstance(keys, list):
            raise ValueError(f"{name}: cropKeys must be a list")
        previous = start - 1
        for j, key in enumerate(keys):
            f, x, y = numbers(key, 3, "cropKeys")
            if not previous < f < end or (j == 0 and (f != start or [x, y] != crop[:2])):
                raise ValueError(f"{name}: cropKeys must begin at range start and crop origin, then increase")
            rect([x, y, *crop[2:]], bounds, "cropKeys")
            previous = f
        mappings = [(crop, [0, 0, w, h])]
        if "inset" in layout:
            inset = layout["inset"]
            mappings.append((rect(inset["source"], bounds, "inset/source"),
                             rect(inset["dest"], (w, h), "inset/dest")))
        for src, dst in mappings:
            if src[2] * dst[3] != src[3] * dst[2]:
                raise ValueError(f"{name}: crop and destination must have the same aspect ratio")
    watches = spec.get("edgeRegions", [])
    if not isinstance(watches, list):
        raise ValueError("edgeRegions must be a list")
    for watch in watches:
        label(watch, "name")
        rect(watch["box"], bounds, "edgeRegions")
        first, last = numbers(watch.get("range", [start, end]), 2, "edgeRegions/range")
        if not start <= first < last <= end:
            raise ValueError("edgeRegions/range must be inside the excerpt")


def crop_at(layout, frame):
    """Keep the FFmpeg pan and the source-to-delivery measurements on the same pixel grid."""
    x, y, w, h = layout["crop"]
    keys = layout.get("cropKeys", [])
    for (f0, x0, y0), (f1, x1, y1) in zip(keys, keys[1:]):
        t = min(1, max(0, (frame-f0)/(f1-f0)))
        ease = t*t*(3-2*t)
        x += (x1-x0)*ease
        y += (y1-y0)*ease
    return [math.floor(x), math.floor(y), w, h]


def pan_expression(keys, axis, start, initial):
    expr = str(initial)
    for left, right in zip(keys, keys[1:]):
        delta = right[axis] - left[axis]
        if delta:
            t = f"clip((n-{left[0]-start})/{right[0]-left[0]},0,1)"
            expr += f"+({delta})*(({t})*({t})*(3-2*({t})))"
    return f"floor({expr})"


def edge_inspection(spec, layout, edges):
    """Partial-only policy for optional interfaces. A complete or absent overlay is allowed."""
    start, end = spec["range"]
    samples = {start, end-1, *(b["frame"] for b in spec["beats"]),
               *(k[0] for k in layout.get("cropKeys", []))}
    anchors = sorted(samples)
    samples.update((a+b)//2 for a, b in zip(anchors, anchors[1:]) if b-a>1)
    # Use presentation time for VFR, with bounded contact-sheet size for long excerpts.
    intervals = max(1, min(32, math.ceil(float(edges[end]-edges[start])*6)))
    for i in range(1, intervals):
        t = edges[start] + (edges[end]-edges[start])*i/intervals
        samples.add(bisect_right(edges, t, start, end)-1)
    alerts = []
    for watch in spec.get("edgeRegions", []):
        begin, finish = watch.get("range", [start, end])
        run = None
        for f in range(begin, finish):
            views = measure_views(watch, dict(layout, crop=crop_at(layout, f)))
            if any(view["state"] == "clipped" for view in views):
                if run is None:
                    run = f
            elif run is not None:
                alerts.append({"name": watch["name"], "range": [run, f]})
                run = None
        if run is not None:
            alerts.append({"name": watch["name"], "range": [run, finish]})
    for alert in alerts:
        first, stop = alert["range"]
        samples.update((first, (first+stop-1)//2, stop-1))
    return sorted(samples), alerts


def intersection(a, b):
    x, y = max(a[0], b[0]), max(a[1], b[1])
    w = max(0, min(a[0]+a[2], b[0]+b[2]) - x)
    h = max(0, min(a[1]+a[3], b[1]+b[3]) - y)
    return x, y, w, h


def measure_views(region, layout):
    box = region["box"]
    width, height = layout["size"]
    inset = layout.get("inset")
    views = [("base", layout["crop"], [0, 0, width, height])]
    if inset:
        views.append(("inset", inset["source"], inset["dest"]))
    candidates = []
    for name, src, dst in views:
        x, y, w, h = intersection(box, src)
        scale = dst[2] / src[2]
        projected = [dst[0]+(x-src[0])*scale, dst[1]+(y-src[1])*scale, w*scale, h*scale]
        area = w*h
        if inset and name == "base":
            _, _, covered_w, covered_h = intersection(projected, inset["dest"])
            area -= covered_w*covered_h/(scale*scale)
        fraction = min(1.0, max(0.0, area/(box[2]*box[3])))
        min_w, min_h = region.get("minSize", (0, 0))
        small = projected[2]+1e-6 < min_w or projected[3]+1e-6 < min_h
        state = "clear" if fraction >= 1-1e-7 else ("lost" if fraction <= 1e-7 else "clipped")
        if small and state == "clear":
            state = "small"
        candidates.append({"view": name, "state": state, "visible": round(fraction, 5),
                           "mappedSize": [round(v, 2) for v in projected[2:]]})
    return candidates


def measure(region, layout):
    # The whole cue has to be readable in a single view. Disjoint fragments do not add up.
    return max(measure_views(region, layout),
               key=lambda v: (v["state"] == "clear", v["visible"], v["mappedSize"][1]))


def streams(path):
    cmd = ["ffprobe", "-v", "error", "-protocol_whitelist", "file", "-show_streams",
           "-of", "json", "-i", str(path)]
    data = json.loads(subprocess.run(cmd, capture_output=True, check=True).stdout)["streams"]
    v = next(s for s in data if s["codec_type"] == "video" and not s["disposition"]["attached_pic"])
    if v.get("sample_aspect_ratio", "1:1") not in ("1:1", "0:1", "N/A"):
        raise ValueError("supply a square-pixel screen capture")
    return float(v.get("start_time", 0)), any(s["codec_type"] == "audio" for s in data)


def crop_scale(box, wh, keys=(), start=0):
    x, y, w, h = box
    if keys:
        x = pan_expression(keys, 1, start, x)
        y = pan_expression(keys, 2, start, y)
    return f"crop={w}:{h}:'{x}':'{y}':exact=1,scale={wh[0]}:{wh[1]}:flags=lanczos,setsar=1"


def render(source, bounds, edges, timing, layout, path):
    start, end = bounds
    origin, has_audio = timing
    chain = f"[0:V:0]trim=start_frame={start}:end_frame={end},setpts=PTS-STARTPTS,format=rgb24"
    base = crop_scale(layout["crop"], layout["size"], layout.get("cropKeys"), start)
    inset = layout.get("inset")
    if inset:
        x, y, w, h = inset["dest"]
        patch = crop_scale(inset["source"], [w, h])
        graph = (chain + f",split[base][patch];[base]{base}[bg];[patch]{patch}[fg];"
                 f"[bg][fg]overlay={x}:{y}:format=rgb,format=yuv420p[v]")
    else:
        graph = chain + "," + base + ",format=yuv420p[v]"
    if has_audio:
        a, b = origin + float(edges[start]), origin + float(edges[end])
        graph += f";[0:a:0]atrim=start={a:.9f}:end={b:.9f},asetpts=PTS-({a:.9f})/TB[a]"
    # A VFR excerpt may end on a long presentation hold. The MP4 muxer otherwise
    # infers its last duration from nominal cadence. With no B-frames N is display order.
    last_duration = float(edges[end] - edges[end-1])
    durations = f"setts=duration='if(eq(N,{end-start-1}),round({last_duration:.12f}/TB),DURATION)'"
    cmd = ["ffmpeg", "-nostdin", "-v", "error", "-xerror", "-protocol_whitelist", "file",
           "-copyts", "-i", str(source), "-filter_complex_threads", "1", "-filter_complex", graph,
           "-map", "[v]", "-c:v", "libx264", "-crf", "16", "-preset", "veryfast",
           "-bf", "0", "-fps_mode", "passthrough", "-enc_time_base:v", "filter", "-bsf:v", durations]
    if has_audio:
        cmd += ["-map", "[a]", "-c:a", "aac", "-b:a", "160k"]
    subprocess.run(cmd + ["-movflags", "+faststart", str(path)], check=True, capture_output=True)
    actual, pts = probe(path)
    if actual["frames"] != end-start or any(abs(float(t-(s-edges[start]))) > .001
            for t, s in zip(pts, edges[start:end+1])):
        raise ValueError(f"{layout['name']}: delivery timestamps do not match the marked capture")


PHASES = {"before": "До действия", "action": "Действие", "response": "Результат"}
STATES = {"clear": "сохранено", "small": "мельче заданного", "clipped": "обрезано", "lost": "потеряно"}


def page(data):
    esc = html.escape
    source = data["source"]
    blocks = ['<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
              '<style>body{font:16px/1.45 system-ui;max-width:1100px;margin:2rem auto;padding:0 1rem;color:#182231}section{border-top:1px solid #aaa;margin-top:2rem}figure{margin:.3rem 0 1rem}img,video{max-width:100%;height:auto}details{margin:1rem 0}.alert{color:#8d3011}small{color:#475568}</style>',
              '<title>Читаемость игрового события</title>', f'<h1>{esc(data["event"])}</h1>',
              f'<p>{esc(Path(source).name)} · {data["media"]["width"]} × {data["media"]["height"]} · '
              f'{data["media"]["frames"]} кадров · {esc(data["media"]["fps"])} fps. '
              f'Проверяемый диапазон [{data["range"][0]}, {data["range"][1]}). <a href="review.json">Измерения JSON</a></p>',
              '<p>Откройте ролик в масштабе публикации. Метки и наблюдения за исходником заданы редактором. '
              'Оцените в движении направление, темп и время на чтение.</p>']
    if data.get("context"):
        blocks.append(f'<p>{esc(data["context"])}</p>')
    for row in data["deliveries"]:
        w, h = row["size"]
        blocks += [f'<section><h2>{esc(row["name"])} · {w} × {h}</h2>',
                   f'<video controls playsinline preload="auto" width="{w}" src="{row["video"]}"></video>',
                   f'<p>Областей для проверки — {row["flagged"]} из {sum(len(b["regions"]) for b in row["beats"])}.</p>']
        if "reviewed" in row:
            blocks.append(f'<p><strong>После просмотра.</strong> {esc(row["reviewed"])}</p>')
        blocks += ['<h3>Края экспортированного кадра</h3>',
                   '<p><label>Полоса для просмотра <select><option value="left">Левая</option>'
                   '<option value="right">Правая</option><option value="top">Верхняя</option>'
                   '<option value="bottom">Нижняя</option></select></label></p>'
                   '<canvas style="max-height:360px;max-width:100%;width:auto;height:auto"></canvas>']
        if data["edgeRegions"]:
            for alert in row["edgeAlerts"]:
                a, b = alert["range"]
                blocks.append(f'<p class="alert">{esc(alert["name"])} · часть области видна в f{a}–{b-1}</p>')
            if not row["edgeAlerts"]:
                blocks.append('<p>По разметке частично видимых зон нет.</p>')
        else:
            blocks.append('<p>Зоны интерфейса не размечены. Проверьте полосы при воспроизведении.</p>')
        blocks.append('<div style="display:flex;flex-wrap:wrap;gap:.45rem">')
        for sample in row["edgeFrames"]:
            f = sample["frame"]
            seek = sample["clipSeconds"] + sample["frameSeconds"] * .25
            blocks.append(f'<figure><a href="{sample["image"]}"><img width="90" loading="lazy" '
                          f'alt="f{f}" src="{sample["image"]}"></a><figcaption>'
                          f'<button data-seek="{seek:.9f}">▶ f{f}</button></figcaption></figure>')
        blocks.append('</div>')
        for b in row["beats"]:
            title = f'{PHASES[b["phase"]]} · исходник f{b["frame"]}, {b["seconds"]:.3f} с'
            if data["range"][0]:
                title += f' · превью f{b["clipFrame"]}, {b["clipSeconds"]:.3f} с'
            seek = b["clipSeconds"] + b["frameSeconds"] * .25
            blocks += [f'<details><summary>{title}</summary><figure><img loading="lazy" width="{w}" '
                       f'src="{b["image"]}" alt="{title}"><figcaption>В исходнике: {esc(b["observed"])}</figcaption></figure>'
                       f'<button data-seek="{seek:.9f}">Открыть кадр в плеере</button><ul>']
            for r in b["regions"]:
                style = '' if r['state'] == 'clear' else ' class="alert"'
                blocks.append(f'<li{style}>{esc(r["name"])} — {STATES[r["state"]]}, '
                              f'{r["visible"]:.1%} площади; размеры в кадре {r["mappedSize"][0]:g} × {r["mappedSize"][1]:g} px.</li>')
            blocks.append('</ul></details>')
        blocks.append('</section>')
    blocks.append('''<script>
document.querySelectorAll('section').forEach(section => {
  const video = section.querySelector('video'), side = section.querySelector('select');
  const canvas = section.querySelector('canvas');
  function draw() {
    if (video.readyState < 2) return;
    const w = video.videoWidth, h = video.videoHeight;
    let x = 0, y = 0, sw = w, sh = h;
    if (['left','right'].includes(side.value)) sw = Math.ceil(w * .2);
    else sh = Math.ceil(h * .2);
    if (side.value === 'right') x = w - sw;
    if (side.value === 'bottom') y = h - sh;
    if (canvas.width !== sw || canvas.height !== sh) { canvas.width = sw; canvas.height = sh; }
    canvas.getContext('2d').drawImage(video, x, y, sw, sh, 0, 0, sw, sh);
  }
  side.onchange = draw;
  for (const event of ['loadeddata','seeked','timeupdate']) video.addEventListener(event, draw);
  if ('requestVideoFrameCallback' in video) {
    function next() { draw(); video.requestVideoFrameCallback(next); }
    video.requestVideoFrameCallback(next);
  }
  draw();
});
document.querySelectorAll('button[data-seek]').forEach(button => {
  button.onclick = () => {
    const video = button.closest('section').querySelector('video');
    const seek = () => {
      video.pause();
      video.currentTime = Math.min(Number(button.dataset.seek), video.duration);
      video.scrollIntoView({block: 'center'});
    };
    if (video.readyState) seek();
    else video.addEventListener('loadedmetadata', seek, {once: true});
  };
});
</script></html>''')
    return '\n'.join(blocks)


def review(manifest, out):
    spec = json.loads(manifest.read_text(encoding="utf-8-sig"))
    source = (manifest.parent / spec["source"]).resolve(strict=True)
    if out.exists():
        raise ValueError("choose a new report directory")
    media, edges = probe(source)
    timing = streams(source)
    validate(spec, media)
    start, end = spec["range"]
    results = {"event": spec["event"], "source": str(source), "media": media, "range": [start, end],
               "context": spec.get("context", ""), "edgeRegions": spec.get("edgeRegions", []), "deliveries": []}
    if not isinstance(results["context"], str):
        raise ValueError("context must be text")
    out.parent.mkdir(exist_ok=True, parents=True)
    with tempfile.TemporaryDirectory(dir=out.parent, prefix=".game-review-") as tmp:
        stage = Path(tmp) / "report"
        stage.mkdir()
        for i, layout in enumerate(spec["layouts"], 1):
            movie = f"view-{i}.mp4"
            render(source, [start, end], edges, timing, layout, stage/movie)
            marks, alerts = edge_inspection(spec, layout, edges)
            row = dict(layout, video=movie, beats=[], flagged=0, edgeAlerts=alerts, edgeFrames=[])
            beats = {b["frame"]: b for b in spec["beats"]}
            frames = proxy_frames(stage/movie, *layout["size"], [f-start for f in marks])
            for f, frame in zip(marks, frames, strict=True):
                image = f'view-{i}-f{f}.' + ('png' if f in beats else 'jpg')
                Image.fromarray(frame).save(stage/image)
                sample = dict(frame=f, image=image, seconds=float(edges[f]), clipFrame=f-start,
                              clipSeconds=float(edges[f]-edges[start]), frameSeconds=float(edges[f+1]-edges[f]),
                              crop=crop_at(layout, f))
                row["edgeFrames"].append(sample)
                if f not in beats:
                    continue
                beat = beats[f]
                cues = [dict(r, **measure(r, dict(layout, crop=sample["crop"]))) for r in beat["regions"]]
                row["flagged"] += sum(r["state"] != "clear" for r in cues)
                row["beats"].append({**beat, **sample, "regions": cues})
            results["deliveries"].append(row)
        (stage/"review.html").write_text(page(results), encoding="utf-8")
        (stage/"review.json").write_text(json.dumps(results, indent=2, ensure_ascii=False), encoding="utf-8")
        stage.rename(out)
    print(out/"review.html")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()
    try:
        review(args.manifest, args.out)
    except subprocess.CalledProcessError as err:
        sys.exit((err.stderr or b"FFmpeg/FFprobe failed").decode(errors="replace").strip())
    except (ValueError, TypeError, KeyError, OSError) as err:
        sys.exit(f"gameplay_review: {err}")
