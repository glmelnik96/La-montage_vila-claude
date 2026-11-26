"""Local picture measurements at reading holds on the common version-review clock."""

import base64
import io
import subprocess

import numpy as np
from PIL import Image, ImageDraw


def sample_frames(path, origin, marks, size):
    width, height = size
    scale = min(1, 960 / max(size))
    w, h = max(1, round(width * scale)), max(1, round(height * scale))
    select = "+".join(f"eq(n\\,{origin + frame})" for frame in marks)
    cmd = [
        "ffmpeg",
        "-v",
        "error",
        "-nostdin",
        "-protocol_whitelist",
        "file",
        "-i",
        str(path),
        "-map",
        "0:v:0",
        "-vf",
        f"select={select},scale={w}:{h}:flags=area",
        "-fps_mode",
        "passthrough",
        "-frames:v",
        str(len(marks)),
        "-pix_fmt",
        "rgb24",
        "-threads:v",
        "1",
        "-f",
        "rawvideo",
        "pipe:1",
    ]
    raw = subprocess.run(cmd, capture_output=True, check=True).stdout
    if len(raw) != len(marks) * w * h * 3:
        raise ValueError(f"could not read all hold samples from {path}")
    return dict(zip(marks, np.frombuffer(raw, np.uint8).reshape(-1, h, w, 3)))


def preview(samples, frames, cols, rows):
    w, h = samples[0].shape[2], samples[0].shape[1]
    thumb_w, thumb_h = min(w, 400), max(1, round(h * min(w, 400) / w))
    result = Image.new("RGB", (len(frames) * thumb_w, 2 * (thumb_h + 20)), "#151515")
    draw = ImageDraw.Draw(result)
    for v, pics in enumerate(samples):
        for i, frame in enumerate(frames):
            x, y = i * thumb_w, v * (thumb_h + 20)
            draw.text(
                (x + 4, y + 3),
                f"{'BEFORE' if v == 0 else 'AFTER'}   f{frame}",
                fill="white",
            )
            result.paste(
                Image.fromarray(pics[i]).resize((thumb_w, thumb_h), Image.Resampling.LANCZOS),
                (x, y + 20),
            )
            for col in range(1, cols):
                at = x + col * thumb_w // cols
                draw.line((at, y + 20, at, y + 19 + thumb_h), fill="#7c8590")
            for row in range(1, rows):
                at = y + 20 + row * thumb_h // rows
                draw.line((x, at, x + thumb_w - 1, at), fill="#7c8590")
    buffer = io.BytesIO()
    result.save(buffer, format="JPEG", quality=89)
    return base64.b64encode(buffer.getvalue()).decode("ascii")


def measurements(before, after):
    # Arrays contain only the sampled instants of this tile.
    a, b = before.astype(np.int16), after.astype(np.int16)

    def motion(tile):
        return max(float(np.abs(tile[i] - tile[j]).mean()) for i in range(len(tile)) for j in range(i))

    def bright_mask(tile):
        return (tile.min(axis=-1) >= 185) & (np.ptp(tile, axis=-1) <= 55)

    original_masks, masks = bright_mask(a), bright_mask(b)
    union = masks.any(axis=0).sum()
    cross_union = (original_masks | masks).sum(axis=(1, 2))
    cross_intersection = (original_masks & masks).sum(axis=(1, 2))
    return {
        "cross_mae": [round(float(d), 4) for d in np.abs(a - b).mean(axis=(1, 2, 3))],
        "before_motion_mae": round(motion(a), 4),
        "after_motion_mae": round(motion(b), 4),
        "after_bright_mask_iou": round(float(masks.all(axis=0).sum() / union), 4) if union >= 9 else None,
        "cross_bright_mask_iou": [
            round(float(i / u), 4) if u >= 9 else None for i, u in zip(cross_intersection, cross_union)
        ],
    }


def analyze(paths, origins, size, holds, threshold, allowed):
    hold_samples = [sorted({start, (start + stop - 1) // 2, stop - 1}) for start, stop in holds]
    marks = sorted({frame for sample in hold_samples for frame in sample})
    decoded = [sample_frames(p, o, marks, size) for p, o in zip(paths, origins)]
    h, w = decoded[0][marks[0]].shape[:2]
    cols, rows = min(8, w), min(6, h)
    result = {"proxy_size": [w, h], "columns": cols, "rows": rows, "holds": []}
    panels = []
    for (start, stop), frames in zip(holds, hold_samples):
        pics = [np.stack([side[f] for f in frames]) for side in decoded]
        tiles = {}
        for row in range(rows):
            for col in range(cols):
                x, right = col * w // cols, (col + 1) * w // cols
                y, bottom = row * h // rows, (row + 1) * h // rows
                tiles[f"R{row + 1}C{col + 1}"] = measurements(*(p[:, y:bottom, x:right] for p in pics))
        peaks = [max(t["cross_mae"][i] for t in tiles.values()) for i in range(len(frames))]
        unexpected = [
            f
            for f, peak in zip(frames, peaks)
            if peak > threshold and not any(a <= f < b for a, b in allowed)
        ]
        result["holds"].append(
            {
                "in": start,
                "out": stop,
                "frames": frames,
                "unexpected_frames": unexpected,
                "tiles": tiles,
            }
        )
        tiles_html = []
        for name, t in tiles.items():
            cross = " / ".join(f"{v:.2f}" for v in t["cross_mae"])
            mask = t["after_bright_mask_iou"]
            mask_text = "—" if mask is None else f"{mask:.3f}"
            cross_mask = " / ".join("—" if v is None else f"{v:.3f}" for v in t["cross_bright_mask_iou"])
            tiles_html.append(
                f"<tr><td>{name}</td><td>{cross}</td><td>{t['before_motion_mae']:.2f}</td>"
                f"<td>{t['after_motion_mae']:.2f}</td><td>{mask_text}</td><td>{cross_mask}</td></tr>"
            )
        buttons = " ".join(f'<button data-frame="{f}">Кадр {f}</button>' for f in frames)
        image = preview(pics, frames, cols, rows)
        panels.append(
            f"<details><summary>Удержание {start}–{stop - 1} · максимум по сетке {max(peaks):.2f}</summary>"
            f'<p>{buttons}</p><img style="max-width:100%" alt="Версии и сетка по порядку выборки" '
            f'src="data:image/jpeg;base64,{image}"><table><thead><tr><th>Область</th>'
            "<th>До / после, MAE по меткам</th><th>Движение до</th><th>Движение после</th>"
            "<th>Стабильность светлых пикселей после, IoU</th><th>IoU до / после по меткам</th></tr></thead><tbody>"
            + "".join(tiles_html)
            + "</tbody></table></details>"
        )
    legend = (
        "<h2>Локальные изменения на удержаниях</h2><p>R1C1 — верхний левый угол. "
        "Движение — максимальная разница между выбранными моментами внутри версии. "
        "Сверьте содержимое ячейки, текст и контраст в плеере оригинального размера. "
        "IoU светлых нейтральных пикселей служит ориентиром для светлой графики.</p>"
    )
    return result, legend + "".join(panels)
