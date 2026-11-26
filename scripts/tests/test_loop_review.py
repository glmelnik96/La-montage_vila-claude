import json
import subprocess
import sys
import tempfile
import unittest
import wave
from pathlib import Path

import numpy as np

CLI = Path(__file__).resolve().parents[1] / "loop_review.py"


class LoopReviewTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.levels = [round(105 + 38*np.sin(i*2*np.pi/24)) for i in range(24)]
        self.count = 0

    def video(self, levels, with_sound=False, click=False, vfr=False, fps=25, trim_audio=0):
        self.count += 1
        target = self.root / f"source-{self.count}.mkv"
        frames = np.repeat(np.asarray(levels, np.uint8), 80*64*3)
        cmd = ["ffmpeg", "-nostdin", "-v", "error", "-f", "rawvideo", "-pix_fmt", "rgb24",
               "-s", "80x64", "-r", str(fps), "-i", "-"]
        if with_sound:
            rate = 48000
            clock = np.arange(len(levels)*rate//fps-trim_audio)/rate
            signal = .27*np.cos(2*np.pi*250*clock)
            stereo = np.column_stack((signal, signal))
            if click:
                stereo[len(clock)//2:, 1] += .4
            file = self.root / f"{self.count}.wav"
            with wave.open(str(file), "wb") as writer:
                writer.setparams((2, 2, rate, 0, "NONE", "not compressed"))
                writer.writeframes((stereo*32767).astype("<i2").tobytes())
            cmd.extend(["-i", str(file), "-c:a", "pcm_s16le"])
        if vfr:
            cmd += ["-vf", "settb=1/1000,setpts=40*N+40*gte(N\\,8)", "-fps_mode", "vfr"]
        cmd.extend(["-c:v", "ffv1", str(target)])
        subprocess.run(cmd, input=frames.tobytes(), check=True)
        return target

    def run_cli(self, file, code, *extra):
        self.count += 1
        out = self.root / f"out-{self.count}"
        result = subprocess.run([sys.executable, str(CLI), str(file), "--out", str(out), *extra], capture_output=True)
        self.assertEqual(result.returncode, code, result.stderr.decode(errors="replace"))
        if code == 2:
            self.assertFalse((out/"review.html").exists())
            return
        page = (out/"review.html").read_text(encoding="utf-8")
        self.assertIn("data:image/jpeg;base64", page)
        return json.loads((out/"review.json").read_text(encoding="utf-8"))

    def test_moving_wrap_and_duplicate(self):
        d = self.run_cli(self.video(self.levels), 0, "--expect-frames", "24", "--expect-fps", "25")
        self.assertEqual(d["boundaries"][0]["picture"]["status"], "within_local_motion")
        self.assertEqual(d["boundaries"][0]["audio"]["status"], "no_audio_stream")
        b = self.run_cli(self.video(self.levels + self.levels[:1]), 1)["boundaries"][0]
        self.assertEqual(b["picture"]["status"], "repeated_edge_frame")

    def test_declared_and_unplanned_holds(self):
        held = self.video([self.levels[0]]*2 + self.levels + self.levels[:1])
        self.assertEqual(self.run_cli(held, 1)["boundaries"][0]["picture"]["status"], "unplanned_hold_review")
        self.assertEqual(self.run_cli(held, 0, "--expect-hold", "4")["boundaries"][0]["picture"]["status"], "expected_hold")
        self.assertEqual(self.run_cli(held, 1, "--expect-hold", "3")["boundaries"][0]["picture"]["status"], "hold_mismatch")

    def test_flash_duration_and_unexpected_first_frame(self):
        def result(levels, code):
            report = self.run_cli(self.video(levels), code, "--expect-flash", "2")
            return report["boundaries"][0]["picture"]["status"]
        self.assertEqual(result(self.levels+[238, 238], 0), "expected_flash")
        self.assertEqual(result(self.levels+[238], 1), "flash_mismatch")
        self.assertEqual(result([0]+self.levels[1:]+[238, 238], 1), "flash_flank_review")

    def test_internal_join_and_duration(self):
        d = self.run_cli(self.video([45]*12+[140]*12), 1, "--once", "--join", "12", "--expect-frames", "25")
        self.assertEqual(len(d["boundaries"]), 1)
        self.assertEqual(d["boundaries"][0]["picture"]["status"], "jump")
        self.assertTrue(d["global_issues"])

    def test_stereo_click_and_continuous_wave(self):
        good = self.run_cli(self.video(self.levels, with_sound=True), 0)["boundaries"][0]["audio"]
        bad = self.run_cli(self.video(self.levels, with_sound=True, click=True), 1)["boundaries"][0]["audio"]
        self.assertEqual(good["status"], "within_local_audio")
        self.assertEqual(bad["click_channels"], [2])

    def test_vfr_and_short_inputs(self):
        data = self.run_cli(self.video(self.levels, vfr=True), 1, "--expect-fps", "25")
        self.assertFalse(data["regular_grid"])
        self.assertIn(80, data["boundaries"][0]["durations_ms"])
        self.run_cli(self.video([10, 20, 30, 40]), 2)
        self.run_cli(self.video(self.levels), 2, "--once", "--join", "24")

    def test_quantized_video_clock_and_real_audio_duration(self):
        clock = self.levels * 4
        good = self.run_cli(self.video(clock, with_sound=True, fps=24), 0, "--expect-fps", "24")
        self.assertTrue(good["regular_grid"])
        self.assertEqual(good["seconds"], 4.0)
        self.assertLess(good["boundaries"][0]["audio"]["step"][0], .002)
        short = self.run_cli(self.video(clock, with_sound=True, fps=24, trim_audio=48), 1)
        self.assertEqual(short["boundaries"][0]["audio"]["status"], "audio_coverage_review")


if __name__ == "__main__":
    unittest.main()
