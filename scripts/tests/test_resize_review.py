import json
import importlib.util
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from PIL import Image, ImageDraw


SCRIPT = Path(__file__).resolve().parents[1] / "resize_review.py"


class ResizeReviewTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / "formats.json").write_text(json.dumps([
            {"key": "small", "ids": ["a", "b", "c"]},
            {"key": "wide", "ids": ["x", "y", "z"]}]))
        self.config = {
            "formats": "formats.json", "dependencies": {"b": ["component"], "component": ["art"]},
            "timing": {"fps": 10, "holds": [0, 5, 10], "joins": [[1,4],[6,10]]},
            "outputs": [{"id": "small-1", "format": "small", "deliverable": "one.zip", "size": [64,48],
                         "before": "old.mkv", "after": "new.mkv"},
                        {"id": "wide-1", "format": "wide", "deliverable": "one.zip", "size": [64,48],
                         "before": "old.mkv", "after": "old.mkv"}]}

    def cli(self, *args, status=0):
        (self.root / "job.json").write_text(json.dumps(self.config))
        out = self.root / "out"
        r = subprocess.run([sys.executable, str(SCRIPT), str(self.root/"job.json"), "--out", str(out), *args],
                           capture_output=True, encoding="utf8", errors="replace")
        self.assertEqual(r.returncode, status, r.stderr)
        return json.loads((out / "review.json").read_text(encoding="utf8")) if status != 2 else None

    def films(self, frames):
        for name, changed in [("old",set()), ("new",set(frames))]:
            for i in range(11):
                im = Image.new("RGB",(64,48),"#2d2d2d")
                if i in changed:
                    ImageDraw.Draw(im).rectangle((2,3,11,12), fill="white")
                im.save(self.root/f"src{i:02}.png")
            subprocess.run(["ffmpeg","-nostdin","-v","error","-framerate","10","-i",str(self.root/"src%02d.png"),
                            "-an","-c:v","ffv1",str(self.root/f"{name}.mkv")],check=True)

    def test_shared_source_and_both_neighbours(self):
        self.config["outputs"].append(dict(self.config["outputs"][0],id="small-2",size=[128,96]))
        r = self.cli("--plan-only","--changed","art","--control","wide-1")
        self.assertEqual(r["formats"],{"small":[{"state":2,"board":"b"}]})
        self.assertEqual(r["rebuild"],{"one.zip":["small-1","small-2"]})
        self.assertEqual(len(r["outputs"]),3)
        self.assertEqual({0,2,5,8,10} - {f["frame"] for f in r["outputs"][0]["samples"]},set())

    def test_last_board_wrap(self):
        self.config["timing"]["wrap"] = [11,15]
        r = self.cli("--plan-only","--changed","c")
        roles = [role for s in r["outputs"][0]["samples"] for role in s["role"]]
        self.assertTrue(any("F3 → F1" in text for text in roles))
        self.assertFalse(any("F1 → F2" in text for text in roles))

    def test_cycle_unknown_and_dependent_control(self):
        self.config["dependencies"]["art"]=["b"]
        self.cli("--plan-only","--changed","art",status=2)
        del self.config["dependencies"]["art"]
        self.cli("--plan-only","--changed","absent",status=2)
        self.cli("--plan-only","--changed","b","--control","small-1",status=2)
        self.assertFalse((self.root/"out").exists())

    def test_real_video_control_and_box(self):
        self.films(range(2,9))
        r = self.cli("--changed","b","--control","wide-1")
        self.assertEqual(r["status"],"sampled")
        target = next(s for s in r["outputs"][0]["samples"] if s["frame"]==5)
        self.assertEqual((target["pixels"],target["bbox"]),(100,[2,3,12,13]))
        self.assertFalse(any(s["pixels"] for s in r["outputs"][1]["samples"]))

    def test_changed_neighbour_and_missing_delivery(self):
        self.films([0,5])
        self.config["dependencies"]["y"]=["art"]
        self.config["outputs"].pop()
        r = self.cli("--changed","art",status=1)
        self.assertEqual(r["findings"],["changed_neighbour","missing_output"])

    def test_no_visible_change_flag(self):
        self.films([])
        self.assertEqual(self.cli("--changed","b",status=1)["findings"],["no_visible_change"])

    @unittest.skipUnless(importlib.util.find_spec("playwright"), "HTML capture uses Playwright")
    def test_html_clock_method_and_seek_return(self):
        html = """<!doctype html><style>*{margin:0}body{background:#000}</style><script>
        let clock=0;
        window.__motion = {fps:10, duration:1.1, ready:true, TIME
          seek(t){clock=t; document.body.style.background=(CHANGE && t>0.15 && t<0.9)?'white':'black'; return t;}};
        </script>"""
        (self.root/"old.html").write_text(html.replace("TIME","time(){return clock;},").replace("CHANGE","false"))
        (self.root/"new.html").write_text(html.replace("TIME","").replace("CHANGE","true"))
        self.config["outputs"][0].update(before="old.html",after="new.html")
        r = self.cli("--changed","b")
        self.assertEqual(r["status"],"sampled")
        self.assertEqual(next(s["pixels"] for s in r["outputs"][0]["samples"] if s["frame"]==5),64*48)


if __name__ == "__main__":
    unittest.main()
