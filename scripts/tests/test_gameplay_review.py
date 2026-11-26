import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np
from PIL import Image

SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS))


class GameplayReviewTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.path = self.root / "запись.mp4"
        self.manifest = self.root / "event.json"
        self.out = self.root / "deliveries"
        self.spec = {
            "event": "<test>", "source": self.path.name, "range": [3, 11],
            "beats": [{"frame": f, "phase": phase, "observed": "visible",
                       "regions": [{"name": "HUD", "box": [2, 2, 12, 8], "minSize": [10, 6]},
                                   {"name": "character", "box": [60, 36, 12, 12]}]}
                      for f, phase in [(3, "before"), (6, "action"), (10, "response")]],
            "layouts": [{"name": "wide", "size": [128, 72], "crop": [0, 0, 128, 72]},
                        {"name": "crop", "size": [40, 72], "crop": [44, 0, 40, 72]},
                        {"name": "inset", "size": [40, 72], "crop": [44, 0, 40, 72],
                         "inset": {"source": [0, 0, 16, 12], "dest": [2, 2, 16, 12]}}]}

    def capture(self, vfr=False, delayed_audio=False):
        frames = np.zeros((14, 72, 128, 3), np.uint8)
        frames[:, 2:10, 2:14, 0] = 220
        frames[:, 36:48, 60:72, 1] = 190
        cmd = ["ffmpeg", "-v", "error", "-f", "rawvideo", "-pixel_format", "rgb24", "-s", "128x72",
               "-r", "10", "-i", "pipe:0"]
        if delayed_audio:
            cmd.extend(["-itsoffset", "0.65"])
        cmd.extend(["-f", "lavfi", "-i", "sine=frequency=440:duration=2"])
        if vfr:
            cmd += ["-vf", "setpts='if(gte(N,6),N+2,N)'", "-fps_mode", "vfr"]
        cmd += ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", str(self.path)]
        subprocess.run(cmd, input=frames.tobytes(), check=True, capture_output=True)

    def run_cli(self):
        self.manifest.write_text(json.dumps(self.spec, ensure_ascii=False), encoding="utf-8")
        return subprocess.run([sys.executable, str(SCRIPTS/"gameplay_review.py"), str(self.manifest),
                               "--out", str(self.out)], capture_output=True)

    def test_rendered_geometry_restores_source_pixels_and_audio(self):
        self.capture()
        run = self.run_cli()
        self.assertEqual(run.returncode, 0, run.stderr)
        data = json.loads((self.out/"review.json").read_text(encoding="utf-8"))
        self.assertEqual([r["flagged"] for r in data["deliveries"]], [0, 3, 0])
        patch = data["deliveries"][2]["beats"][1]
        self.assertEqual(patch["regions"][0]["view"], "inset")
        pixels = np.array(Image.open(self.out/patch["image"]))
        np.testing.assert_array_less([190, 130], [pixels[8, 8, 0], pixels[40, 20, 1]])
        plain = np.array(Image.open(self.out/data["deliveries"][1]["beats"][1]["image"]))
        self.assertLess(int(plain[8, 8, 0]), 20)
        a = subprocess.check_output(["ffprobe", "-v", "error", "-select_streams", "a:0",
                                     "-show_entries", "stream=codec_type,duration", "-of", "json",
                                     str(self.out/"view-3.mp4")])
        self.assertAlmostEqual(float(json.loads(a)["streams"][0]["duration"]), .8, places=2)
        self.assertIn("&lt;test&gt;", (self.out/"review.html").read_text(encoding="utf-8"))
        self.assertNotEqual(self.run_cli().returncode, 0)

    def test_variable_fps_keeps_actual_source_beats_and_audio_offset(self):
        self.capture(vfr=True, delayed_audio=True)
        run = self.run_cli()
        self.assertEqual(run.returncode, 0, run.stderr)
        data = json.loads((self.out/"review.json").read_text(encoding="utf-8"))
        action = data["deliveries"][0]["beats"][1]
        self.assertAlmostEqual(action["seconds"], .8)
        self.assertAlmostEqual(action["clipSeconds"], .5)
        self.assertEqual(action["clipFrame"], 3)
        self.assertIn("превью f3, 0.500", (self.out/"review.html").read_text(encoding="utf-8"))
        def onset(path):
            samples = subprocess.check_output(["ffmpeg", "-v", "error", "-copyts", "-i", str(path),
                "-map", "0:a:0", "-af", "aresample=8000:first_pts=0", "-f", "f32le", "-"])
            signal = np.frombuffer(samples, dtype="<f4")
            return np.flatnonzero(np.abs(signal) > .03)[0]/8000
        self.assertAlmostEqual(onset(self.path), .65, delta=.005)
        self.assertAlmostEqual(onset(self.out/"view-1.mp4"), onset(self.path)-.3, delta=.005)

    def test_small_and_obscured_cues(self):
        from gameplay_review import measure

        r = {"box": [40, 20, 12, 12], "minSize": [12, 12]}
        reduced = {"crop": [0, 0, 128, 72], "size": [64, 36]}
        self.assertEqual(measure(r, reduced)["state"], "small")
        overlay = {"crop": [0, 0, 128, 72], "size": [128, 72],
                   "inset": {"source": [0, 0, 12, 12], "dest": [40, 20, 12, 12]}}
        self.assertEqual(measure(r, overlay)["state"], "lost")
        overlay["inset"]["dest"][0] += 6
        self.assertEqual(measure(r, overlay)["visible"], .5)

    def test_pan_finds_partial_hud_between_marks_in_rendered_pixels(self):
        self.capture(vfr=True)
        self.spec["layouts"] = [{"name": "pan", "size": [40, 72], "crop": [0, 0, 40, 72],
                                 "cropKeys": [[3, 0, 0], [5, 24, 0], [6, 0, 0]]}]
        self.spec["edgeRegions"] = [
            {"name": "HUD", "box": [2, 2, 12, 8]},
            {"name": "Out of shot", "box": [90, 0, 3, 3]},
            {"name": "Hidden after f3", "box": [2, 2, 12, 8], "range": [3, 4]}]
        run = self.run_cli()
        self.assertEqual(run.returncode, 0, run.stderr)
        row = json.loads((self.out/"review.json").read_text(encoding="utf-8"))["deliveries"][0]
        self.assertEqual(row["edgeAlerts"], [{"name": "HUD", "range": [4, 5]}])
        self.assertTrue(all(b["regions"][0]["state"] == "clear" for b in row["beats"]))
        samples = {s["frame"]: s for s in row["edgeFrames"]}
        self.assertEqual(samples[4]["crop"][0], 12)
        self.assertAlmostEqual(samples[4]["clipSeconds"], .1)
        self.assertEqual(samples[10]["crop"][0], 0)
        partial = np.asarray(Image.open(self.out/samples[4]["image"]))
        absent = np.asarray(Image.open(self.out/samples[5]["image"]))
        self.assertGreater(int(partial[6, 0, 0]), 110)
        self.assertLess(int(partial[6, 8, 0]), 40)
        self.assertLess(int(absent[6, 0, 0]), 40)

    def test_inset_preserves_cue_but_duplicate_fragment_remains(self):
        from gameplay_review import edge_inspection, measure

        layout = {"size": [40, 72], "crop": [8, 0, 40, 72],
                  "inset": {"source": [0, 0, 16, 12], "dest": [20, 20, 16, 12]}}
        hud = {"name": "HUD", "box": [2, 2, 12, 8]}
        self.spec["edgeRegions"] = [hud]
        self.assertEqual(measure(hud, layout)["state"], "clear")
        self.assertEqual(edge_inspection(self.spec, layout, list(range(15)))[1],
                         [{"name": "HUD", "range": [3, 11]}])

    def test_excerpt_preserves_last_vfr_hold(self):
        from video_reference import probe

        self.capture(vfr=True)
        self.spec["range"] = [3, 6]
        self.spec["layouts"] = self.spec["layouts"][:1]
        for beat, frame in zip(self.spec["beats"], [3, 4, 5]):
            beat["frame"] = frame
        run = self.run_cli()
        self.assertEqual(run.returncode, 0, run.stderr)
        timing = probe(self.out/"view-1.mp4")[1]
        self.assertAlmostEqual(float(timing[-1]-timing[-2]), .3)

    def test_invalid_geometry_publishes_nothing(self):
        self.capture()
        self.spec["layouts"][1]["crop"] = [0, 0, 42, 72]
        self.assertNotEqual(self.run_cli().returncode, 0)
        self.assertFalse(self.out.exists())


if __name__ == "__main__":
    unittest.main()
