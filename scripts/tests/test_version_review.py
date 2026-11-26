"""Entry-point checks for version_review.py using generated lossless media."""

import json
import subprocess
import sys
import tempfile
import unittest
import wave
from pathlib import Path

import numpy as np

CLI = Path(__file__).resolve().parents[1] / "version_review.py"


class VersionReviewTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.temp.cleanup)
        cls.root = Path(cls.temp.name)
        cls.fps = 25
        cls.frames = 75
        cls.sound = np.random.default_rng(123).integers(-5000, 5000, cls.frames * 320, dtype="<i2")
        cls.movie("base")
        cls.movie("delay", video_shift=2, audio_shift=3)
        cls.movie("extra", video_shift=2, extra=True)
        cls.movie("silence", silent=True)
        cls.movie("mute", audio=False)
        cls.movie("short", frames=70)
        cls.movie("wide", width=100)
        cls.movie("corner", corner=True)
        for name in ("base", "delay"):
            subprocess.run(
                [
                    "ffmpeg",
                    "-nostdin",
                    "-v",
                    "error",
                    "-display_rotation:v:0",
                    "90",
                    "-i",
                    str(cls.root / (name + ".mp4")),
                    "-c",
                    "copy",
                    str(cls.root / (name + "-rotated.mp4")),
                ],
                capture_output=True,
                check=True,
            )
        subprocess.run(
            [
                "ffmpeg",
                "-nostdin",
                "-v",
                "error",
                "-i",
                str(cls.root / "base.mp4"),
                "-vf",
                "trim=start_frame=5,setpts=PTS-STARTPTS",
                "-af",
                "atrim=start=0.2,asetpts=PTS-STARTPTS",
                "-c:v",
                "libx264rgb",
                "-crf",
                "0",
                "-threads:v",
                "1",
                "-c:a",
                "alac",
                str(cls.root / "trimmed.mp4"),
            ],
            capture_output=True,
            check=True,
        )

    @classmethod
    def movie(
        cls, name, video_shift=0, audio_shift=0, extra=False, silent=False, audio=True, frames=75, width=80, corner=False
    ):
        path = cls.root / (name + ".mp4")
        video = np.full((frames, 64, width, 3), 30, dtype=np.uint8)
        for frame in range(frames):
            local = frame - video_shift - 20
            if 0 <= local < 16:
                video[frame, 12:30, 4:28] = (45 + local * 9, 218 - local * 8, 160)
            if extra and 55 <= frame < 59:
                video[frame, 34:62] = 185
            if corner and frame == 28:
                video[frame, -4:, -4:] = 255
        cmd = [
            "ffmpeg",
            "-nostdin",
            "-v",
            "error",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgb24",
            "-s",
            f"{width}x64",
            "-framerate",
            str(cls.fps),
            "-i",
            "-",
        ]
        if audio:
            wav = cls.root / (name + ".wav")
            track = np.zeros(frames * 320, dtype="<i2")
            start = audio_shift * 320
            if not silent:
                track[start:] = cls.sound[: len(track) - start]
            with wave.open(str(wav), "wb") as out:
                out.setparams((1, 2, 8000, 0, "NONE", ""))
                out.writeframes(track.tobytes())
            cmd.extend(["-i", str(wav), "-c:a", "alac"])
        cmd.extend(["-c:v", "libx264rgb", "-crf", "0", "-threads:v", "1", str(path)])
        subprocess.run(cmd, input=video.tobytes(), capture_output=True, check=True)

    def review(self, before, after, code, *options, expected_summary=None):
        results = self.root / ("review-" + self._testMethodName + "-" + before + "-" + after)
        cmd = [
            sys.executable,
            str(CLI),
            self.root / (before + ".mp4"),
            self.root / (after + ".mp4"),
            "--out",
            results,
            "--roi",
            "title:4,12,24,18",
            *options,
        ]
        run = subprocess.run(cmd, capture_output=True, encoding="utf-8", errors="replace")
        self.assertEqual(run.returncode, code, f"{run.stdout}\n{run.stderr}")
        if expected_summary:
            self.assertIn(expected_summary, run.stdout)
        page = (results / "review.html").read_text(encoding="utf-8")
        self.assertIn(".mp4", page)
        self.assertIn("<video", page)
        return json.loads((results / "review.json").read_text(encoding="utf-8"))

    def test_identical_picture_and_sound(self):
        report = self.review("base", "base", 0)
        self.assertEqual(report["common_frames"], 75)
        self.assertEqual(report["sound"]["lag_ms"], 0)
        self.assertFalse(any(report["picture"].values()))
        self.assertEqual(report["sound"]["events"], [])

        self.assertNotIn("hold_review", report)

    def test_local_change_only_at_middle_and_last_pixel(self):
        report = self.review("base", "corner", 1, "--hold", "26:31", expected_summary="1 unexpected local hold frames")
        self.assertFalse(any(report["picture"].values()))
        hold = report["hold_review"]["holds"][0]
        self.assertEqual(hold["unexpected_frames"], [28])
        self.assertEqual(hold["frames"], [26, 28, 30])
        edge = hold["tiles"]["R6C8"]
        self.assertGreater(edge["cross_mae"][1], 4)
        self.assertEqual(edge["before_motion_mae"], 0)
        self.assertGreater(edge["after_motion_mae"], 4)
        self.assertEqual(edge["cross_bright_mask_iou"], [None, 0, None])

    def test_moving_identical_inputs_and_aligned_permitted_hold(self):
        report = self.review("base", "base", 0, "--hold", "20:31")
        hold = report["hold_review"]["holds"][0]
        self.assertGreater(max(t["after_motion_mae"] for t in hold["tiles"].values()), 4)
        self.assertFalse(hold["unexpected_frames"])
        allowed = self.review(
            "base",
            "corner",
            0,
            "--align",
            "26:26",
            "--frames",
            "5",
            "--hold",
            "0:5",
            "--allow-video",
            "2:3",
        )
        tile = allowed["hold_review"]["holds"][0]["tiles"]["R6C8"]
        self.assertGreater(tile["cross_mae"][1], 4)

    def test_invalid_holds(self):
        base = self.root / "base.mp4"
        for other, hold in [
            (base, "0:1"),
            (base, "74:76"),
            (self.root / "wide.mp4", "2:5"),
        ]:
            run = subprocess.run(
                [
                    sys.executable,
                    CLI,
                    base,
                    other,
                    "--out",
                    self.root / "invalid",
                    "--hold",
                    hold,
                ],
                capture_output=True,
            )
            self.assertEqual(run.returncode, 2)
            self.assertFalse((self.root / "invalid" / "review.json").exists())

    def test_delayed_title_and_sound(self):
        report = self.review("base", "delay", 1)
        title = report["picture"]["title"]
        self.assertTrue(any(e["lag_frames"] == 2 and 20 <= e["worst_frame"] < 38 for e in title))
        self.assertEqual(report["sound"]["lag_ms"], 120)
        self.assertEqual(report["sound"]["lag_frames"], 3)
        self.assertFalse(report["sound"]["events"][0]["allowed"])

    def test_negative_lag_has_opposite_sign(self):
        report = self.review("delay", "base", 1)
        self.assertTrue(any(e["lag_frames"] == -2 for e in report["picture"]["title"]))
        self.assertEqual(report["sound"]["lag_frames"], -3)

    def test_expected_windows_are_track_specific(self):
        report = self.review("base", "delay", 0, "--allow-video", "18:40", "--allow-audio", "0:75")
        self.assertEqual(report["unexpected_intervals"], 0)
        self.assertTrue(all(e["allowed"] for e in report["picture"]["title"]))
        self.assertTrue(report["sound"]["events"][0]["allowed"])

    def test_outside_edit_window(self):
        report = self.review("base", "extra", 1, "--allow", "18:40")
        unexpected = [r for r in report["picture"]["Кадр"] if not r["allowed"]]
        self.assertEqual([(r["in"], r["out"]) for r in unexpected], [(55, 59)])
        self.assertEqual(report["sound"]["lag_frames"], 0)

    def test_duration_and_geometry(self):
        short = self.review("base", "short", 1)
        self.assertEqual(short["common_frames"], 70)
        self.assertTrue(any("70" in s for s in short["notes"]))
        wide = self.review("base", "wide", 1)
        self.assertEqual(wide["picture"], {})
        self.assertEqual(wide["after"]["size"], [100, 64])

    def test_manual_edit_alignment(self):
        report = self.review("base", "trimmed", 0, "--align", "5:0")
        self.assertEqual(report["start_frames"], [5, 0])
        self.assertEqual(report["common_frames"], 70)
        self.assertEqual(report["sound"]["lag_ms"], 0)
        self.assertEqual(report["unexpected_intervals"], 0)
        crop = self.review("base", "delay", 0, "--align", "20:22", "--frames", "16", "--allow-audio", "0:16")
        self.assertEqual(crop["common_frames"], 16)
        self.assertFalse(any(crop["picture"].values()))
        self.assertEqual(crop["sound"]["lag_frames"], 1)

    def test_roi_after_display_rotation(self):
        report = self.review("base-rotated", "delay-rotated", 1, "--roi", "rotated=12,52,18,24")
        self.assertEqual(report["before"]["rotation"], 90)
        self.assertEqual(report["before"]["size"], [64, 80])
        self.assertEqual(report["before"]["coded_size"], [80, 64])
        self.assertFalse(report["picture"]["title"])
        self.assertTrue(any(e["lag_frames"] == 2 for e in report["picture"]["rotated"]))

    def test_rejects_existing_report(self):
        place = self.root / "preserved"
        place.mkdir()
        sentinel = place / "review.json"
        sentinel.write_text("prior result", encoding="utf-8")
        video = self.root / "base.mp4"
        run = subprocess.run(
            [sys.executable, str(CLI), str(video), str(video), "--out", str(place)], capture_output=True
        )
        self.assertEqual(run.returncode, 2)
        self.assertEqual(sentinel.read_text(encoding="utf-8"), "prior result")
        self.assertFalse((place / "review.html").exists())

    def test_missing_or_uninformative_audio(self):
        silent = self.review("silence", "silence", 0)
        self.assertEqual(silent["sound"]["status"], "no_unique_shared_signal")
        self.assertIsNone(silent["sound"]["lag_ms"])
        self.assertEqual(self.review("mute", "mute", 0)["sound"]["status"], "no_audio_in_either_export")
        self.assertEqual(self.review("base", "mute", 1)["sound"]["status"], "track_or_channel_count_changed")


if __name__ == "__main__":
    unittest.main()
