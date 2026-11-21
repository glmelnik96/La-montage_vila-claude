# Hear a cut before making it. For each proposed removal [a, b], build the audio
# exactly as it will sound after the edit ([a - pre, a] joined to [b, b + post]),
# transcribe it, and print the words on either side of the join. A word that
# straddles the join means the blade lands inside speech.
#
#   python scripts/splicecheck.py <media> --cuts '[[a, b, "label"], ...]' [--pre 5] [--post 5]
#   python scripts/splicecheck.py <media> --windows '[[t0, t1, "label"], ...]'
#
# --windows transcribes untouched stretches with a time per word — use it to find
# out what a stumble actually is before deciding where the blade goes.
#
# This catches what a level check cannot: a clean silence that is the WRONG
# silence, so the sentence comes out missing a word or with a stray syllable.
import os, sys, glob, json, site, argparse, subprocess, tempfile


def add_cuda_dlls():
    if os.name != 'nt':
        return
    for sp in site.getsitepackages() + [site.getusersitepackages()]:
        for d in glob.glob(os.path.join(sp, 'nvidia', '*', 'bin')):
            os.add_dll_directory(d)
            os.environ['PATH'] = d + os.pathsep + os.environ['PATH']


add_cuda_dlls()
import ctranslate2
from faster_whisper import WhisperModel

ap = argparse.ArgumentParser()
ap.add_argument('media')
ap.add_argument('--cuts', default='[]'); ap.add_argument('--windows', default='[]')
ap.add_argument('--pre', type=float, default=5.0); ap.add_argument('--post', type=float, default=5.0)
ap.add_argument('--model', default='large-v3'); ap.add_argument('--lang', default='ru')
a = ap.parse_args()

dev = 'cuda' if ctranslate2.get_cuda_device_count() > 0 else 'cpu'
model = WhisperModel(a.model, device=dev, compute_type='float16' if dev == 'cuda' else 'int8')


def words_of(wav):
    segs, _ = model.transcribe(wav, language=a.lang, word_timestamps=True, beam_size=5,
                               vad_filter=False, condition_on_previous_text=False)
    return [(w.start, w.end, w.word.strip()) for s in segs for w in s.words if w.word.strip()]


for t0, t1, label in json.loads(a.windows):
    wav = tempfile.mktemp(suffix='.wav')
    subprocess.run(['ffmpeg', '-v', 'error', '-ss', str(t0), '-t', str(t1 - t0), '-i', a.media,
                    '-ac', '1', '-ar', '16000', '-y', wav], check=True)
    try:
        ws = words_of(wav)
    finally:
        os.remove(wav)
    print(f'\n=== {label}  {t0}-{t1}')
    print('   ' + '  '.join(f'{w}@{t0 + s:.2f}-{t0 + e:.2f}' for s, e, w in ws))

for c in json.loads(a.cuts):
    ca, cb, label = c[0], c[1], (c[2] if len(c) > 2 else '')
    pre = min(a.pre, ca)
    wav = tempfile.mktemp(suffix='.wav')
    subprocess.run(['ffmpeg', '-v', 'error', '-ss', str(ca - pre), '-t', str(pre), '-i', a.media,
                    '-ss', str(cb), '-t', str(a.post), '-i', a.media,
                    '-filter_complex', '[0:a][1:a]concat=n=2:v=0:a=1[o]', '-map', '[o]',
                    '-ac', '1', '-ar', '16000', '-y', wav], check=True)
    try:
        ws = words_of(wav)
    finally:
        os.remove(wav)
    before = [w for s, e, w in ws if e <= pre + 0.05]
    after = [w for s, e, w in ws if s >= pre - 0.05]
    straddle = [w for s, e, w in ws if s < pre - 0.05 and e > pre + 0.05]
    flag = f'   STRADDLES THE JOIN: {" ".join(straddle)}' if straddle else ''
    print(f'{label:<10} [{ca}-{cb}]  ...{" ".join(before[-7:])}  ||  {" ".join(after[:7])}...{flag}')
