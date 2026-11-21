# Re-transcribe ONE window with word timestamps.
#
# Whisper sometimes collapses 30 s of speech into a single segment carrying one
# start and one end. A reel boundary that lands inside such a segment cannot be
# checked against the transcript at all — you cannot tell whose sentence you are
# cutting. Re-run just that window to get words back.
#
#   python scripts/rewin.py <media> <fromSec> <toSec>
#
# Times printed are absolute in the source, not relative to the window.
#
# WARNING: word timestamps are NOT silence. Whisper pads word ends and reports
# gaps where the room is not actually quiet. Use these times to find out WHAT is
# said and in what order, then put the blade with audio.mjs. See
# references/vertical-reels.md.
import sys, subprocess, tempfile, os
from faster_whisper import WhisperModel

if len(sys.argv) < 4:
    sys.exit('usage: rewin.py <media> <fromSec> <toSec> [model]')

src, t0, t1 = sys.argv[1], float(sys.argv[2]), float(sys.argv[3])
model = sys.argv[4] if len(sys.argv) > 4 else 'medium'

wav = tempfile.mktemp(suffix='.wav')
subprocess.run(['ffmpeg', '-v', 'error', '-ss', str(t0), '-t', str(t1 - t0), '-i', src,
                '-ac', '1', '-ar', '16000', '-y', wav], check=True)
try:
    m = WhisperModel(model, device='cpu', compute_type='int8')
    segs, _ = m.transcribe(wav, language='ru', word_timestamps=True, vad_filter=False)
    for s in segs:
        for w in s.words:
            print(f'{t0 + w.start:8.2f} {t0 + w.end:8.2f}  {w.word}')
finally:
    os.remove(wav)
