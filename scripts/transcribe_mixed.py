# Mixed-language transcription with word times, for interviews where the subject
# answers in one language and the crew talks in another between takes. A single-
# language pass hides the crew: large-v3 forced to English TRANSLATES Russian
# chatter ("ещё раз", "стоп, давай сначала") into fluent English that reads like
# the subject's answer. So every voice chunk gets its own language, and each
# same-language run is transcribed in that language.
#
#   python scripts/transcribe_mixed.py --clips clips.json --out <prefix>
#          [--langs en,ru,hi] [--model large-v3]
#
# clips.json: [{"path": "...", "start": <timeline s>, "in": <src s>, "out": <src s>,
#               "name": "...", "idx": N}, ...]
# Writes <prefix>.words.json [{s, e, w, p, lang, clip, nsp}], <prefix>.segments.json,
# <prefix>.chunks.json (voice chunks with their language) and <prefix>.txt, all in
# timeline seconds. --langs restricts detection: accented English otherwise drifts
# to hi/ur on short chunks. Word times say what was said and roughly when; place
# cuts with audio.mjs / scan.mjs.
import os, sys, glob, io, json, time, site, argparse


def add_cuda_dlls():
    if os.name != 'nt':
        return
    for sp in site.getsitepackages() + [site.getusersitepackages()]:
        for d in glob.glob(os.path.join(sp, 'nvidia', '*', 'bin')):
            os.add_dll_directory(d)
            os.environ['PATH'] = d + os.pathsep + os.environ['PATH']


add_cuda_dlls()
import ctranslate2
from faster_whisper import WhisperModel, decode_audio
from faster_whisper.vad import VadOptions, get_speech_timestamps

ap = argparse.ArgumentParser()
ap.add_argument('--clips', required=True); ap.add_argument('--out', required=True)
ap.add_argument('--langs', default='en,ru'); ap.add_argument('--model', default='large-v3')
a = ap.parse_args()
LANGS, SR = a.langs.split(','), 16000
clips = json.load(io.open(a.clips, encoding='utf-8'))
dev = 'cuda' if ctranslate2.get_cuda_device_count() > 0 else 'cpu'
model = WhisperModel(a.model, device=dev, compute_type='float16' if dev == 'cuda' else 'int8')
VAD = VadOptions(min_silence_duration_ms=300, speech_pad_ms=120, max_speech_duration_s=20)


def lid(x):
    _, _, allp = model.detect_language(audio=x)
    probs = {l: p for l, p in allp if l in LANGS}
    best = max(probs, key=probs.get)
    return best, round(probs[best] / (sum(probs.values()) or 1), 3)


def dist(q, r):
    return max(0.0, q['s'] - r['e'], r['s'] - q['e'])


words, chunks, t0 = [], [], time.time()
for c in clips:
    try:
        x = decode_audio(c['path'], sampling_rate=SR)
    except Exception as e:
        print(f'skip {c.get("name")}: {e}', file=sys.stderr)
        continue
    x, off = x[int(c['in'] * SR):int(c['out'] * SR)], c['start']
    ch = [{'s': t['start'] / SR, 'e': t['end'] / SR} for t in get_speech_timestamps(x, vad_options=VAD)]
    for r in ch:
        r['lang'], r['p'] = lid(x[int(r['s'] * SR):int(r['e'] * SR)])
    # a short chunk ("стоп", "go") is a weak vote: take the nearest confident neighbour's language
    for r in ch:
        if r['e'] - r['s'] < 1.0 and r['p'] < 0.9:
            near = [q for q in ch if q is not r and q['e'] - q['s'] >= 1.0 and dist(q, r) < 2.0]
            if near:
                r['lang'], r['inh'] = min(near, key=lambda q: dist(q, r))['lang'], True
    runs = []
    for r in ch:
        if runs and runs[-1]['lang'] == r['lang'] and r['s'] - runs[-1]['e'] < 1.5:
            runs[-1]['e'] = r['e']
        else:
            runs.append({'s': r['s'], 'e': r['e'], 'lang': r['lang']})
    for u in runs:
        s0 = max(0.0, u['s'] - 0.1)
        segs, _ = model.transcribe(x[int(s0 * SR):int((u['e'] + 0.1) * SR)], language=u['lang'],
                                   word_timestamps=True, beam_size=5, vad_filter=True,
                                   vad_parameters=dict(min_silence_duration_ms=500, speech_pad_ms=200),
                                   condition_on_previous_text=False)
        for s in segs:
            for w in (s.words or []):
                if w.word.strip():
                    words.append({'s': round(off + s0 + w.start, 3), 'e': round(off + s0 + w.end, 3),
                                  'w': w.word.strip(), 'p': round(w.probability, 3), 'lang': u['lang'],
                                  'clip': c.get('idx'), 'nsp': round(s.no_speech_prob, 2)})
    for r in ch:
        chunks.append(dict({'clip': c.get('idx'), 's': round(off + r['s'], 2), 'e': round(off + r['e'], 2),
                            'lang': r['lang'], 'p': r['p']}, **({'inh': True} if r.get('inh') else {})))
    print(f'{c.get("idx")} {c.get("name")}: {len(ch)} chunks, {len(runs)} runs ({time.time() - t0:.0f}s)',
          file=sys.stderr, flush=True)

# segments: one clip, one language, broken on real gaps and sentence ends
segs, cur = [], []


def flush():
    if cur:
        segs.append({'startSec': cur[0]['s'], 'endSec': cur[-1]['e'], 'lang': cur[0]['lang'],
                     'clip': cur[0]['clip'], 'text': ' '.join(w['w'] for w in cur)})


for w in words:
    if cur:
        gap, dur = w['s'] - cur[-1]['e'], cur[-1]['e'] - cur[0]['s']
        endp = cur[-1]['w'][-1:] in '.?!…'
        if (w['clip'] != cur[-1]['clip'] or w['lang'] != cur[-1]['lang'] or gap > 0.8
                or (endp and (gap > 0.15 or dur > 4)) or dur > 14):
            flush()
            cur = []
    cur.append(w)
flush()


def w_json(path, obj):
    with io.open(path, 'w', encoding='utf-8') as f:
        json.dump(obj, f, ensure_ascii=False, indent=0)


def mmss(t):
    return f'{int(t // 60)}:{t % 60:04.1f}'


w_json(a.out + '.words.json', words)
w_json(a.out + '.segments.json', segs)
w_json(a.out + '.chunks.json', chunks)
with io.open(a.out + '.txt', 'w', encoding='utf-8') as f:
    for c in clips:
        mine = [s for s in segs if s['clip'] == c.get('idx')]
        f.write(f"\n== #{c.get('idx')} {c.get('name', '')}  [{mmss(c['start'])}, {c['out'] - c['in']:.1f}s]"
                f"{'' if mine else '  (no speech)'}\n")
        for s in mine:
            tag = '' if s['lang'] == LANGS[0] else f"({s['lang']}) "
            f.write(f"[{mmss(s['startSec'])}] {tag}{s['text']}\n")
print(f'{dev}: {len(clips)} clips in {time.time() - t0:.0f}s -> {len(words)} words, {len(segs)} segments',
      file=sys.stderr)
