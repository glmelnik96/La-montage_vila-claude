# Local transcription with word timestamps: the fallback when the panel's cloud
# Whisper is down, and the better source anyway, since every word gets a time
# instead of a segment time that drifts by seconds.
#
#   python scripts/transcribe_local.py <audio> <out_prefix> [--model large-v3]
#          [--lang ru] [--device auto|cuda|cpu] [--hotwords "..."] [--seq-id ID --seq-name NAME]
#
# --device cpu when another program holds the GPU (ComfyUI and the like): large-v3 still runs,
# much slower. auto takes the GPU whenever one exists, even a full one.
#
# Writes <out_prefix>.words.json / .segments.json / .srt / .txt, and with
# --seq-id also <out_prefix>.omc.json in the panel's transcript format.
#
# GPU on Windows: the CUDA 12 build of CTranslate2 needs cuBLAS 12 and cuDNN 9.
# pip's nvidia-cublas-cu12 / nvidia-cudnn-cu12 put them in site-packages/nvidia/
# */bin, which Windows does not search, so without add_cuda_dlls() the model
# loads and then dies with "cublas64_12.dll is not found".
#
# Word times say WHAT was said and roughly when. Place cuts with audio.mjs.
import os, sys, glob, io, json, time, site, argparse, datetime


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
ap.add_argument('audio'); ap.add_argument('out')
ap.add_argument('--model', default='large-v3'); ap.add_argument('--lang', default='ru')
ap.add_argument('--hotwords', default=None)
ap.add_argument('--device', default='auto', choices=['auto', 'cuda', 'cpu'])
ap.add_argument('--seq-id', default=None); ap.add_argument('--seq-name', default='')
a = ap.parse_args()
os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
if a.hotwords:
    print('WARNING: --hotwords silently halved the output of a 63-min recording; compare words per minute', file=sys.stderr)

dev = a.device if a.device != 'auto' else ('cuda' if ctranslate2.get_cuda_device_count() > 0 else 'cpu')
try:
    model = WhisperModel(a.model, device=dev, compute_type='float16' if dev == 'cuda' else 'int8')
except Exception as e:
    print(f'GPU init failed ({e}); falling back to CPU', file=sys.stderr)
    dev = 'cpu'
    model = WhisperModel(a.model, device='cpu', compute_type='int8')

t0 = time.time()
# condition_on_previous_text=False: large-v3 otherwise tends to loop on long
# recordings. Do NOT pass --hotwords on long recordings: on a 63-min lecture they
# halved the output (151 vs 284 words on the same 150 s) with no error at all.
segs, info = model.transcribe(a.audio, language=a.lang, word_timestamps=True, beam_size=5,
                              vad_filter=True,
                              vad_parameters=dict(min_silence_duration_ms=500, speech_pad_ms=200),
                              condition_on_previous_text=False, hotwords=a.hotwords)
words, last = [], 0
for s in segs:
    for w in (s.words or []):
        words.append({'s': round(w.start, 3), 'e': round(w.end, 3), 'w': w.word.strip(), 'p': round(w.probability, 3)})
    if s.end - last > 300:
        last = s.end
        print(f'  {s.end / 60:5.1f} of {info.duration / 60:.1f} min  ({time.time() - t0:.0f}s)', file=sys.stderr, flush=True)
words = [w for w in words if w['w']]

# Re-segment on sentence ends and real gaps: whisper's own segments can span
# 30 s, useless for subtitles and for finding a cut.
out, cur = [], []


def flush():
    if cur:
        out.append({'startSec': cur[0]['s'], 'endSec': cur[-1]['e'], 'text': ' '.join(x['w'] for x in cur)})


for w in words:
    if cur:
        gap = w['s'] - cur[-1]['e']
        dur = cur[-1]['e'] - cur[0]['s']
        endp = cur[-1]['w'][-1:] in '.?!…'
        if gap > 0.8 or (endp and (gap > 0.15 or dur > 4)) or dur > 14:
            flush()
            cur = []
    cur.append(w)
flush()


def w_json(path, obj):
    with io.open(path, 'w', encoding='utf-8') as f:
        json.dump(obj, f, ensure_ascii=False, indent=0)


def ts(t):
    ms = int(round(t * 1000))
    h, ms = divmod(ms, 3600000)
    m, ms = divmod(ms, 60000)
    s, ms = divmod(ms, 1000)
    return f'{h:02d}:{m:02d}:{s:02d},{ms:03d}'


w_json(a.out + '.words.json', words)
w_json(a.out + '.segments.json', out)
with io.open(a.out + '.srt', 'w', encoding='utf-8') as f:
    for i, s in enumerate(out, 1):
        f.write(f"{i}\n{ts(s['startSec'])} --> {ts(s['endSec'])}\n{s['text']}\n\n")
with io.open(a.out + '.txt', 'w', encoding='utf-8') as f:
    for s in out:
        f.write(f"[{int(s['startSec'] // 60)}:{int(s['startSec'] % 60):02d}] {s['text']}\n")
if a.seq_id:
    w_json(a.out + '.omc.json', {
        'format': 'omc-transcript', 'formatVersion': 1,
        'exportedAt': datetime.datetime.utcnow().isoformat() + 'Z', 'panelVersion': None,
        'seqId': a.seq_id, 'seqName': a.seq_name,
        'entry': {'raw': {}, 'segments': [dict(s, startVerified=False, endVerified=False) for s in out]}})
print(f'{dev}: {info.duration / 60:.1f} min in {time.time() - t0:.0f}s -> {len(words)} words, {len(out)} segments',
      file=sys.stderr)
