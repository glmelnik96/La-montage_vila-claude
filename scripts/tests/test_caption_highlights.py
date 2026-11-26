import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np

SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS))
from caption_highlights import highlight_box  # noqa: E402


class CaptionHighlightTest(unittest.TestCase):
    def test_sparse_pixels_and_background_are_ignored(self):
        im = np.zeros((20, 30, 3), dtype=np.uint8)
        color = np.array([30, 195, 70])
        im[3, 2] = color
        self.assertIsNone(highlight_box(im, color, tolerance=4, min_pixels=20))
        im[6:17, 10:22] = color
        self.assertEqual(highlight_box(im, color, 4, 20), (10, 6, 22, 17))

    def test_frame_range_disappearance_and_return_at_same_position(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            src = folder / "sample.mkv"
            output = folder / "out.json"
            frames = np.zeros((8, 36, 64, 3), dtype=np.uint8)
            for i, x in enumerate([10,10,11,None,11,25,25,None]):
                if x is not None:
                    frames[i, 10:20, x:x+9] = (35,210,90)
            subprocess.run(["ffmpeg", "-v", "error", "-f", "rawvideo", "-s", "64x36",
                            "-pixel_format", "rgb24", "-framerate", "25", "-i", "pipe:0",
                            "-c:v", "ffv1", str(src)], input=frames.tobytes(), check=True)
            cli = [sys.executable, str(SCRIPTS/"caption_highlights.py"), str(src),
                   "--box", "5", "3", "39", "25", "--rgb", "35", "210", "90",
                   "--frames", "1", "8", "--jitter", "2", "--out", str(output)]
            subprocess.run(cli, check=True, capture_output=True)
            data = json.loads(output.read_text(encoding="utf-8"))
            events = data["highlights"]
            self.assertEqual([(r["in"], r["out"]) for r in events], [(1,3),(4,5),(5,7)])
            self.assertEqual(events[0]["box"], [10,10,9,10])
            self.assertAlmostEqual(events[2]["endSec"], .28)
            original = src.read_bytes()
            refusal = subprocess.run([*cli[:-1], str(src)], capture_output=True)
            self.assertNotEqual(refusal.returncode, 0)
            self.assertEqual(src.read_bytes(), original)


if __name__ == "__main__":
    unittest.main()
