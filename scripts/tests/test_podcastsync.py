"""Exercise the offline CLI with known time axes and unrelated/ambiguous audio."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import wave

import numpy as np


SCRIPT = Path(__file__).resolve().parents[1] / "podcastsync.py"
RATE = 8000


def source(seconds, seed):
    rng = np.random.default_rng(seed)
    samples = int(seconds * RATE)
    steps = np.arange(0, samples + RATE, RATE // 5)
    level = np.interp(np.arange(samples), steps, rng.uniform(.03, .8, len(steps)))
    return np.clip(rng.normal(size=samples) * level * .21, -1, 1)


def guide(recording, seconds, offset, ppm=0):
    times = offset * RATE + np.arange(round(seconds * RATE)) * (1 + ppm / 1e6)
    return np.interp(times, np.arange(len(recording)), recording, left=0, right=0)


class PodcastSyncTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.rec = source(92, 1)
        self.wav("take", self.rec)

    def wav(self, name, samples):
        with wave.open(str(self.root / (name + ".wav")), "wb") as out:
            out.setparams((1, 2, RATE, 0, "NONE", "not compressed"))
            out.writeframes((samples * 32767).astype("<i2").tobytes())

    @staticmethod
    def item(name, **metadata):
        return {"id": name, "file": name + ".wav", **metadata}

    def run_cli(self, takes, cameras, expected):
        manifest = self.root / "manifest.json"
        manifest.write_text(json.dumps({"fps": "30000/1001", "takes": takes, "cameras": cameras}),
                            encoding="utf-8")
        process = subprocess.run([sys.executable, str(SCRIPT), str(manifest), "--out", str(self.root)],
                                 capture_output=True, text=True)
        self.assertEqual(process.returncode, expected, (process.stderr, process.stdout))
        return json.loads((self.root / "podcastsync.json").read_text(encoding="utf-8"))["cameras"]

    def test_offset_drift_preroll_and_silence(self):
        self.wav("moving", guide(self.rec, 72, 12.375, 120))
        self.wav("early", guide(self.rec, 32, -3.125))
        self.wav("blank", np.zeros(RATE * 12))
        self.wav("other", source(80, 73))
        rows = self.run_cli([self.item("take", timelineStartSec=100), self.item("other")],
                            [self.item("moving"), self.item("early"), self.item("blank")], 1)
        moving, early, blank = rows
        self.assertEqual((moving["status"], moving["take"]), ("matched", "take"))
        self.assertAlmostEqual(moving["offsetSec"], 12.375, delta=.002)
        self.assertAlmostEqual(moving["driftPpm"], 120, delta=8)
        self.assertEqual(moving["placement"]["frame"], round(112.375 * 30000 / 1001))
        self.assertEqual(early["status"], "matched")
        self.assertAlmostEqual(early["offsetSec"], -3.125, delta=.002)
        self.assertEqual(blank["status"], "unconfirmed")
        self.assertNotIn("placement", blank)

    def test_ambiguity_within_and_between_takes(self):
        phrase = source(16, 3)
        self.wav("repeat", np.r_[source(3, 10), phrase, source(12, 11), phrase, source(6, 12)])
        self.wav("phrase", phrase)
        (row,) = self.run_cli([self.item("repeat", timelineStartSec=0)], [self.item("phrase")], 1)
        self.assertEqual((row["status"], row["pairs"][0]["status"]), ("ambiguous", "ambiguous"))
        self.assertNotIn("placement", row)
        offsets = sorted(c["guideOffsetSec"] for c in row["pairs"][0]["candidates"] if c.get("verified"))
        np.testing.assert_allclose(offsets, [3, 31], atol=.002)
        self.wav("part", guide(self.rec, 25, 13))
        (row,) = self.run_cli([self.item("take"), {"id": "dup", "file": "take.wav"}],
                              [self.item("part")], 1)
        self.assertEqual(row["status"], "ambiguous")
        self.assertTrue(all(pair["status"] == "matched" for pair in row["pairs"]))

    def test_origins_and_missing_take(self):
        self.wav("short", guide(self.rec, 5, 6.25))
        (row,) = self.run_cli([self.item("take", audioStartSec=7)],
                              [self.item("short", audioStartSec=2)], 0)
        self.assertAlmostEqual(row["offsetSec"], 11.25, delta=.002)
        self.assertIsNone(row["driftPpm"])
        self.assertNotIn("placement", row)
        (row,) = self.run_cli([self.item("take", timelineStartSec=40), self.item("missing")],
                              [self.item("short")], 1)
        self.assertEqual(row["status"], "incomplete")
        self.assertNotIn("placement", row)
        self.assertEqual(next(p["status"] for p in row["pairs"] if p["take"] == "missing"), "unavailable")

    def test_timecode_only_suggests_the_matching_clock(self):
        recording = source(130, 2)
        self.wav("long", recording)
        self.wav("anchor", guide(recording, 104, 12))
        self.wav("outside", np.zeros(RATE * 3))
        self.wav("foreign", np.zeros(RATE * 3))
        anchor, outside, foreign = self.run_cli(
            [self.item("long", timelineStartSec=100)],
            [self.item("anchor", clockGroup="cam-A-day1", timecodeSec=50),
             self.item("outside", clockGroup="cam-A-day1", timecodeSec=20),
             self.item("foreign", clockGroup="cam-B", timecodeSec=20)], 1)
        self.assertEqual(anchor["status"], "matched")
        self.assertEqual(outside["status"], "unconfirmed")
        self.assertNotIn("placement", outside)
        hint = outside["timecodeHint"]
        self.assertEqual((hint["anchor"], hint["check"]), ("anchor", "no_audio_overlap"))
        self.assertAlmostEqual(hint["suggestedOffsetSec"], -18, delta=.002)
        self.assertNotIn("timecodeHint", foreign)


if __name__ == "__main__":
    unittest.main()
