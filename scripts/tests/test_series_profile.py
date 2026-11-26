import json
import subprocess
import sys
import tempfile
import unittest
from fractions import Fraction
from pathlib import Path

import numpy as np

SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS))
from series_profile import compare, event_rates, learn, title_metrics  # noqa: E402


class SeriesProfileTests(unittest.TestCase):
    def test_word_offset_vfr_unicode_and_overlapping_coverage(self):
        edges = list(map(Fraction, ["0", ".02", ".10", ".18", ".23", ".26"]))
        common = {
            "kind": "subtitle",
            "text": "Проект «Ёлки-палки» готов",
            "box": [0, 50, 50, 25],
        }
        marks = [
            dict(common, **{"in": 1, "out": 4, "speechFrame": 2}),
            dict(common, **{"in": 3, "out": 5}),
        ]
        values, support = title_metrics(
            marks, edges, [0, 5], {"width": 100, "height": 100}, False, ["subtitle"]
        )
        self.assertEqual(values["title.subtitle.words"], 3)
        self.assertAlmostEqual(values["title.subtitle.screen_minus_speech_s"], -0.08)
        self.assertAlmostEqual(values["title.subtitle.coverage_pct"], 100 * 24 / 26)
        self.assertEqual(values["title.subtitle.center_y_pct"], 62.5)
        self.assertEqual(support["subtitle"]["speechAnchors"], 1)
        with self.assertRaises(ValueError):
            title_metrics(
                [dict(marks[0], box=[50, 0, 51, 20])],
                edges,
                [0, 5],
                {"width": 100, "height": 100},
                False,
            )

    def test_confirmed_zero_and_missing_evidence(self):
        refs = [
            {
                "id": str(i),
                "sha256": str(i),
                "cutBasis": "editorial",
                "titlesComplete": True,
                "titleSupport": {"subtitle": {}},
                "metrics": {
                    "title.subtitle.coverage_pct": v,
                    "title.subtitle.hold_s": 1,
                },
            }
            for i, v in enumerate([10, 12, 18])
        ]
        profile = learn("Подкаст", refs, 10)
        new = dict(refs[0], id="new", sha256="new", metrics={}, titleSupport={})
        measured = compare(profile, new)
        self.assertEqual(measured["title.subtitle.coverage_pct"]["value"], 0)
        self.assertEqual(measured["title.subtitle.coverage_pct"]["status"], "outside")
        self.assertEqual(measured["title.subtitle.hold_s"]["status"], "kind_absent")
        self.assertEqual(
            compare(profile, dict(new, titlesComplete=False))[
                "title.subtitle.coverage_pct"
            ]["status"],
            "not_observed",
        )
        with self.assertRaisesRegex(ValueError, "already"):
            compare(profile, dict(new, sha256="0"))
        with self.assertRaisesRegex(ValueError, "repeat"):
            learn("Повтор", refs + [dict(refs[0], id="renamed")], 10)

    def test_only_logged_events_are_scored(self):
        self.assertEqual(event_rates({}, 0, 25, 1), {})
        self.assertEqual(
            event_rates(
                {"broll": {"frames": [2, 10], "evidence": "sequence"}}, 0, 25, 1
            ),
            {"event.broll.per_min": 120},
        )
        with self.assertRaises(ValueError):
            event_rates({"sfx": {"frames": [3]}}, 0, 25, 1)

    def test_cli_measures_real_cuts_and_reuses_saved_profile(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            inputs = []
            for i in range(4):
                video = root / f"{i}.mp4"
                pic = np.full((20, 16, 32, 3), 30 + i, dtype=np.uint8)
                pic[10:] = 190 + i
                subprocess.run(
                    [
                        "ffmpeg",
                        "-v",
                        "error",
                        "-f",
                        "rawvideo",
                        "-s",
                        "32x16",
                        "-pix_fmt",
                        "rgb24",
                        "-r",
                        "25",
                        "-i",
                        "pipe:0",
                        "-c:v",
                        "libx264rgb",
                        "-crf",
                        "0",
                        str(video),
                    ],
                    input=pic.tobytes(),
                    check=True,
                )
                inputs.append({"id": str(i), "media": video.name})
            manifest = root / "manifest.json"
            out = root / "out"
            cli = [sys.executable, str(SCRIPTS / "series_profile.py")]
            manifest.write_text(
                json.dumps({"series": "A", "episodes": inputs[:3]}), encoding="utf-8"
            )
            subprocess.run(
                [*cli, "learn", str(manifest), "--out", str(out)],
                check=True,
                capture_output=True,
            )
            profile = json.loads((out / "style.json").read_text(encoding="utf-8"))
            self.assertEqual([r["cuts"] for r in profile["references"]], [[10]] * 3)
            self.assertEqual(profile["bands"]["pace.cuts_per_min"]["median"], 75)
            manifest.write_text(json.dumps(inputs[3]), encoding="utf-8")
            subprocess.run(
                [
                    *cli,
                    "check",
                    str(out / "style.json"),
                    str(manifest),
                    "--out",
                    str(out),
                ],
                check=True,
                capture_output=True,
            )
            result = json.loads((out / "comparison.json").read_text(encoding="utf-8"))
            self.assertEqual(
                result["comparison"]["pace.shot_median_s"]["status"], "inside"
            )
            self.assertTrue((out / "comparison.md").is_file())


if __name__ == "__main__":
    unittest.main()
