"""Offline entry-point tests. Run: python scripts/tests/test_takecheck.py -v"""
import json
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from PIL import Image


ROOT = Path(__file__).resolve().parents[2]
CLI = ROOT / "scripts" / "takecheck.py"
GUIDE = ROOT / "references" / "staged-shots.md"


class TakeCheckTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.folder = Path(temp.name)
        # Exercise the published example itself, including the addressing of its v02.
        example = re.search(r"^```json\s*\n(.*?)^```", GUIDE.read_text(encoding="utf-8"), re.M | re.S)
        self.sheet = json.loads(example.group(1))
        self.shots = {row["shot"]: row for row in self.sheet["shots"]}
        self.current = self.shots["B02"]
        self.accepted = next(t for t in self.current["takes"] if t["status"] == "accepted")

    def media(self, filename, frames, colors=None, fps="24", filters=None):
        """Make a black video with solid-colour fiducials at specific source indices."""
        args = ["ffmpeg", "-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i",
                f"color=c=black:s=64x36:r={fps}", "-frames:v", str(frames)]
        if colors:
            filters = ",".join(
                f"drawbox=color={color}:t=fill:enable='eq(n,{n})'" for n, color in colors.items()
            )
        if filters:
            args += ["-vf", filters]
        subprocess.run([*args, "-fps_mode", "passthrough", "-enc_time_base", "1/24000",
                        "-video_track_timescale", "24000", "-c:v", "libx264", "-bf", "0",
                        str(self.folder / filename)], check=True, capture_output=True)

    def check(self, expected_code, *options):
        sheet = self.folder / "лист отбора.json"
        sheet.write_text(json.dumps(self.sheet, ensure_ascii=False), encoding="utf-8-sig")
        # Different cwd from the sheet: relative media paths must follow the sheet.
        run = subprocess.run([sys.executable, str(CLI), str(sheet), *map(str, options)], cwd=ROOT,
                             capture_output=True, encoding="utf-8")
        output = run.stdout + run.stderr
        self.assertEqual(run.returncode, expected_code, output)
        return output

    def test_documented_short_then_complete_replacement(self):
        filename = self.accepted["file"]
        self.media(filename, 40)
        short = self.check(1)
        self.assertIn("B01", short)
        self.assertIn("B03", short)
        self.assertIn("review", short)
        self.assertIn("B02/v02", short)
        self.assertIn("40", short)
        self.media(filename, 52)
        full = self.check(1)
        self.assertIn("1/3", full)
        selected = self.check(0, "--shot", "B02")
        self.assertIn("B02/v02 replaces B02/v01", selected)
        self.assertIn("decoded=52", selected)
        self.assertIn("[4,52)", selected)

    def test_archived_file_cannot_supply_a_missing_selected_version(self):
        archived = self.current["takes"][0]
        self.media(archived["file"], 60)
        message = self.check(1, "--shot", "B02")
        self.assertIn("B02/v02", message)
        self.assertIn(self.accepted["file"], message)

    def test_use_may_be_short_even_if_the_file_is_long(self):
        self.media(self.accepted["file"], 60)
        self.accepted["use"] = [4, 51]
        self.check(1, "--shot", "B02")
        self.accepted["use"] = [4, 52]
        self.check(0, "--shot", "B02")

    def test_ambiguous_selection_and_invalid_replacement_addresses(self):
        previous = self.current["takes"][0]
        previous["status"] = "accepted"
        ambiguous = self.check(1, "--shot", "B02")
        for version in ("v01", "v02"):
            self.assertIn(version, ambiguous)
        previous["status"] = "archive"
        self.accepted["replaces"] = "v17"
        self.assertIn("v17", self.check(2))
        self.accepted["replaces"] = previous["version"]
        previous["replaces"] = self.accepted["version"]
        self.check(2)
        del previous["replaces"]
        self.current["takes"].append(dict(previous))
        self.check(2)

    def test_nearby_fractional_frame_rates_are_distinct(self):
        self.sheet["fps"] = "24000/1001"
        self.media(self.accepted["file"], 52, fps="24000/1001")
        self.check(0, "--shot", "B02")
        self.sheet["fps"] = 24
        message = self.check(1, "--shot", "B02")
        self.assertIn("24000/1001", message)

    def test_variable_pts_with_matching_average_rate(self):
        self.media(self.accepted["file"], 52, filters="settb=1/24000,setpts='PTS+if(eq(N,3),500,0)'")
        message = self.check(1, "--shot", "B02")
        self.assertIn("PTS", message)

    def color_board(self):
        # The five displayed frames are 3, 4, 5 (explicit action), 9 and 13.
        # All other frames stay black, including the midpoint and end handles.
        filename = "action.mp4"
        self.media(filename, 16, {3: "red", 4: "lime", 5: "blue", 9: "yellow", 13: "magenta"})
        for shot_id, cut, usable in (
            ("B01", [0, 2], [2, 15]), ("B02", [2, 8], [4, 16]), ("B03", [8, 10], [13, 16])
        ):
            self.shots[shot_id].update(cut=cut, takes=[
                {"version": "v01", "status": "accepted", "file": filename, "use": usable}
            ])

    def centers(self, output):
        with Image.open(output) as image:
            rgb = image.convert("RGB")
            return [rgb.getpixel((int(x * rgb.width), rgb.height // 2))
                    for x in (0.1, 0.3, 0.5, 0.7, 0.9)]

    def assert_color(self, observed, expected):
        self.assertTrue(all(abs(a - b) <= 12 for a, b in zip(observed, expected)),
                        f"pixel {observed}, expected {expected}")

    def test_context_uses_placed_frames_and_explicit_action(self):
        self.color_board()
        image = self.folder / "junction.png"
        options = ("--shot", "B02", "--action-frame", "5", "--frames", image)
        self.check(0, *options)
        expected = [(255, 0, 0), (0, 255, 0), (0, 0, 255), (255, 255, 0), (255, 0, 255)]
        for observed, color in zip(self.centers(image), expected):
            self.assert_color(observed, color)
        before = image.read_bytes()
        self.check(1, *options)
        self.assertEqual(image.read_bytes(), before)

    def test_named_review_version_and_missing_neighbour(self):
        self.color_board()
        self.shots["B01"]["takes"] = []
        # v01 is selected, but the director asks to see the pending v02 starting at frame 5.
        self.shots["B02"]["takes"].append({
            "version": "v02", "status": "review", "replaces": "v01", "file": "action.mp4", "use": [5, 15]
        })
        image = self.folder / "candidate.png"
        report = self.check(1, "--shot", "B02", "--version", "v02", "--frames", image)
        self.assertIn("B01", report)
        previous, current_in, _, _, following = self.centers(image)
        self.assertLess(max(previous) - min(previous), 45, "missing neighbour showed source footage")
        self.assert_color(current_in, (0, 0, 255))
        self.assert_color(following, (255, 0, 255))


if __name__ == "__main__":
    unittest.main()
