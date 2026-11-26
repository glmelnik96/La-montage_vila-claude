import json
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np

CLI = Path(__file__).resolve().parents[1] / "video_reference.py"


class ReferenceVideoTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)

    def clip(self, vfr=False):
        frames = np.empty((24, 48, 80, 3), dtype=np.uint8)
        frames[:10] = 30
        for i in range(4, 8):
            frames[i, 12:28, 16:32] = 30 + (i - 3) * 15
        frames[10:18] = 220
        frames[18:] = [32, 64, 160]
        path = self.root / "тест.mp4"
        cmd = ["ffmpeg", "-nostdin", "-v", "error", "-f", "rawvideo", "-s", "80x48",
               "-pix_fmt", "rgb24", "-r", "25" if vfr else "30000/1001", "-i", "pipe:0"]
        if vfr:
            cmd += ["-vf", "setpts='if(lt(N,5),N,5+2*(N-5))'", "-fps_mode", "vfr"]
        subprocess.run([*cmd, "-c:v", "libx264rgb", "-crf", "0", str(path)],
                       input=frames.tobytes(), check=True)
        return path

    def run_cli(self, path, *args, out="report"):
        return subprocess.run([sys.executable, str(CLI), str(path), "--out", str(self.root/out), *args],
                              capture_output=True, encoding="utf-8")

    def read_result(self, p):
        self.assertEqual(p.returncode, 0, p.stderr)
        result = json.loads(p.stdout)
        return json.loads(Path(result["json"]).read_text(encoding="utf-8")), Path(result["report"]).read_text(encoding="utf-8")

    def test_timed_cuts_and_local_changes_on_published_report(self):
        path = self.clip()
        run = self.run_cli(path, "--roi", "title&box=16,12,16,16", "--at-frame", "7")
        d, html = self.read_result(run)
        self.assertEqual(d["video"]["fps"], "30000/1001")
        self.assertTrue(d["video"]["on_average_rate_grid"])
        self.assertEqual(d["video"]["frames"], 24)
        self.assertAlmostEqual(d["video"]["seconds"], 24*1001/30000)
        self.assertEqual([c["frame"] for c in d["cuts"]], [10, 18])
        shots = d["shots"]
        self.assertEqual([(s["in"],s["out"]) for s in shots], [(0,10),(10,18),(18,24)])
        self.assertEqual([(e["in"],e["out"]) for e in shots[0]["regions"]["title&box"]
                          if e["state"]=="change"],[(4,9)])
        for shot in shots:
            for events in shot["regions"].values():
                self.assertEqual(events[0]["state"],"baseline")
                self.assertEqual(events[0]["shot_t_in"],0)
                self.assertEqual(events[-1]["out"],shot["out"])
                self.assertTrue(all(a["out"]==b["in"] for a,b in zip(events, events[1:])))
        self.assertIn("title&amp;box",html)
        self.assertIn("data:image/jpeg;base64,", html)
        filename = re.search(r'href="(reference-[a-z0-9]+.json)"', html)[1]
        self.assertEqual(Path(json.loads(run.stdout)["json"]).name, filename)
        rerun = self.run_cli(path, "--roi", "title&box=16,12,16,16", "--at-frame", "7")
        self.assertEqual(json.loads(rerun.stdout),json.loads(run.stdout))

    def test_vfr_uses_actual_frame_times(self):
        d, _ = self.read_result(self.run_cli(self.clip(vfr=True), "--previews", "0"))
        self.assertFalse(d["video"]["on_average_rate_grid"])
        self.assertEqual([c["frame"] for c in d["cuts"]], [10,18])
        self.assertAlmostEqual(d["cuts"][0]["seconds"],15/25)
        second = d["shots"][1]["regions"]["frame"]
        self.assertAlmostEqual(second[1]["shot_t_in"], 2/25)
        self.assertGreater(d["video"]["seconds"],d["cuts"][-1]["seconds"])

    def test_invalid_roi_fails_without_publishing(self):
        r = self.run_cli(self.clip(), "--roi", "label=70,2,12,12")
        self.assertNotEqual(r.returncode,0)
        self.assertIn("exceeds",r.stderr)
        self.assertFalse((self.root/"report"/"report.html").exists())


if __name__ == "__main__":
    unittest.main()
