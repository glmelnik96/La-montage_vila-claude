# Make editable Premiere title cards: one .mogrt per card, cloned from Premiere's own
# «Basic Title.mogrt» with the text, font and size replaced. Imported with
# sequence.importMGT() it becomes an ordinary Graphic clip whose text the user edits in
# the Program monitor or the Essential Graphics panel — unlike a rendered PNG.
#
#   python scripts/mogrtcard.py --cards cards.json --out-dir <dir> [--font SBSansDisplay-Semibold]
#        [--size 64] [--width 34] [--fill 0] [--bg 16777215 --bg-opacity 80 --bg-size 16]
#   cards.json: [{"id": "A03", "text": "Вопрос целиком"}, ...]  ->  <out-dir>/<id>.mogrt
#   A text that already holds line breaks (\r or \n) keeps them: subtitles with the user's lines.
#   --fill is the text colour and --bg a plate behind the text, both as Premiere stores a colour
#   (a 24-bit integer: 0 black, 16777215 white). The plate keys mBackFillVisible / mBackFillColor /
#   mBackFillOpacity / mBackFillSize are not in Basic Title's JSON, but Premiere reads them (found
#   in its binary; a render showed black text on a white plate, 2026-10-08). Rounded plate corners
#   have no key in this JSON at all: they are set in Premiere (Essential Graphics) afterwards.
#
# Why a new file per card: ExtendScript cannot set a graphic's text. `Source Text` reads back as
# a single garbage character and a Premiere-authored .mogrt exposes no MGT parameters
# (getMGTComponent() is null), so the text has to be in the template before import.
# Where it lives: .mogrt (zip) -> project*.prgraphic (zip) -> *.prproj (gzip XML) ->
# <StartKeyframeValue Encoding="base64"> = 8-byte little-endian length + UTF-16LE JSON
# {"mTextParam": {"mStyleSheet": {"mText": ..., "mFontName": ..., "mFontSize": ...}}}.
# Every card gets a fresh capsuleID: Premiere caches template media by it, and cards that
# share one can come up with the same text.
import base64, gzip, io, json, re, struct, sys, uuid, zipfile, os

def arg(k, d=None):
    return sys.argv[sys.argv.index('--' + k) + 1] if '--' + k in sys.argv else d

SRC = arg('template', r'C:/Program Files/Adobe/Adobe Premiere Pro 2026/Essential Graphics/Basic Title.mogrt')
FONT, SIZE, WIDTH = arg('font', 'SBSansDisplay-Semibold'), float(arg('size', 64)), int(arg('width', 34))
FILL, BG = arg('fill'), arg('bg')
BGOP, BGSZ = float(arg('bg-opacity', 80)), float(arg('bg-size', 16))


def wrap(text, width):
    """Break into lines of about `width` characters, never inside a word; Premiere wants \\r."""
    if '\r' in text or '\n' in text:
        return '\r'.join(x.strip() for x in re.split(r'[\r\n]+', text) if x.strip())
    lines, cur = [], ''
    for w in text.split():
        if cur and len(cur) + 1 + len(w) > width:
            lines.append(cur); cur = w
        else:
            cur = (cur + ' ' + w).strip()
    if cur:
        lines.append(cur)
    return '\r'.join(lines)


def patch_prproj(xml, text):
    def repl(m):
        raw = base64.b64decode(m.group(2).strip())
        body = raw[8:].decode('utf-16-le')
        try:
            j = json.loads(body)
        except ValueError:
            return m.group(0)
        if 'mTextParam' not in j:
            return m.group(0)
        ss = j['mTextParam']['mStyleSheet']
        ss['mText'] = text
        ss['mFontName']['mParamValues'] = [[0, FONT]]
        ss['mFontSize']['mParamValues'] = [[0, SIZE]]
        if FILL is not None:
            ss['mFillColor']['mParamValues'] = [[0, int(FILL)]]
        j['mTextParam']['mLeading'] = 0
        if BG is not None:
            tp = j['mTextParam']
            tp['mBackFillVisible'] = True
            tp['mBackFillColor'] = int(BG)
            tp['mBackFillOpacity'] = BGOP
            tp['mBackFillSize'] = BGSZ
        enc = json.dumps(j, ensure_ascii=False, separators=(',', ':')).encode('utf-16-le')
        blob = struct.pack('<Q', len(enc)) + enc
        return m.group(1) + base64.b64encode(blob).decode('ascii') + m.group(3)
    out, n = re.subn(r'(<StartKeyframeValue Encoding="base64"[^>]*>)([^<]+)(</StartKeyframeValue>)', repl, xml)
    return out


def patch_prgraphic(data, text):
    zin = zipfile.ZipFile(io.BytesIO(data))
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as zout:
        for info in zin.infolist():
            b = zin.read(info.filename)
            if info.filename.endswith('.prproj'):
                xml = gzip.decompress(b).decode('utf-8')
                b = gzip.compress(patch_prproj(xml, text).encode('utf-8'))
            zout.writestr(info, b)
    return buf.getvalue()


def make(card, out_dir):
    text = wrap(card['text'], WIDTH)
    zin = zipfile.ZipFile(SRC)
    dst = os.path.join(out_dir, card['id'] + '.mogrt')
    with zipfile.ZipFile(dst, 'w', zipfile.ZIP_DEFLATED) as zout:
        for info in zin.infolist():
            b = zin.read(info.filename)
            if info.filename == 'definition.json':
                d = json.loads(b.decode('utf-8'))
                d['capsuleID'] = str(uuid.uuid4())
                d['capsuleName'] = card['id']
                for s in d.get('capsuleNameLocalized', {}).get('strDB', []):
                    s['str'] = card['id']
                for c in d.get('clientControls', []):
                    for s in (c.get('value') or {}).get('strDB', []):
                        s['str'] = text
                b = json.dumps(d, ensure_ascii=False).encode('utf-8')
            elif info.filename.endswith('.prgraphic'):
                b = patch_prgraphic(b, text)
            elif info.filename.startswith('thumb'):
                continue                       # previews of the stock title; not needed
            zout.writestr(info, b)
    return dst


if __name__ == '__main__':
    cards = json.load(open(arg('cards'), encoding='utf-8'))
    out = arg('out-dir')
    os.makedirs(out, exist_ok=True)
    for c in cards:
        make(c, out)
    print(f'{len(cards)} cards -> {out}')
