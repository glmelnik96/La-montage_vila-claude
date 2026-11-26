# Make editable Premiere title cards: one .mogrt per card, cloned from Premiere's own
# «Basic Title.mogrt» with the text, font and size replaced. Imported with
# sequence.importMGT() it becomes an ordinary Graphic clip whose text the user edits in
# the Program monitor or the Essential Graphics panel — unlike a rendered PNG.
#
#   python scripts/mogrtcard.py --cards cards.json --out-dir <dir> [--font SBSansDisplay-Semibold]
#        [--size 64] [--width 34] [--fill 0] [--bg 16777215 --bg-opacity 80 --bg-size 16] [--align 0]
#   cards.json: [{"id": "A03", "text": "Вопрос целиком"}, ...]  ->  <out-dir>/<id>.mogrt
#   Add "textPosition": [x, y] to bake the archive clip's normalized Text > Position
#   into every localized project. With this field the supplied lines are final, including
#   a single long line. Use a static, single-text-layer Premiere Basic Title derivative.
#   --preserve-style copies the donor's uniform formatting including font, size and leading.
#   Use it with a styled donor instead of specifying font/size/fill/plate/alignment options.
#   A text that already holds line breaks (\r or \n) keeps them: subtitles with the user's lines.
#   --fill is the text colour and --bg a plate behind the text, both as Premiere stores a colour
#   (a 24-bit integer: 0 black, 16777215 white). The plate keys mBackFillVisible / mBackFillColor /
#   mBackFillOpacity / mBackFillSize are not in Basic Title's JSON, but Premiere reads them (found
#   in its binary; a render showed black text on a white plate, 2026-10-08). Rounded plate corners
#   have no key in this JSON at all: they are set in Premiere (Essential Graphics) afterwards.
#   --align sets mTextParam.mAlignment; Basic Title ships with 2 (centred).
#
# Why a new file per card: ExtendScript cannot set a graphic's text. `Source Text` reads back as
# a single garbage character and a Premiere-authored .mogrt exposes no MGT parameters
# (getMGTComponent() is null), so the text has to be in the template before import.
# Where it lives: .mogrt (zip) -> project*.prgraphic (zip) -> *.prproj (gzip XML) ->
# <StartKeyframeValue Encoding="base64"> = 8-byte little-endian length + UTF-16LE JSON
# {"mTextParam": {"mStyleSheet": {"mText": ..., "mFontName": ..., "mFontSize": ...}}}.
# Every card gets a fresh capsuleID: Premiere caches template media by it, and cards that
# share one can come up with the same text.
import base64, gzip, io, json, math, re, struct, sys, tempfile, uuid, zipfile, os
from xml.etree import ElementTree as ET

def arg(k, d=None):
    return sys.argv[sys.argv.index('--' + k) + 1] if '--' + k in sys.argv else d

SRC = arg('template', r'C:/Program Files/Adobe/Adobe Premiere Pro 2026/Essential Graphics/Basic Title.mogrt')
FONT, SIZE, WIDTH = arg('font', 'SBSansDisplay-Semibold'), float(arg('size', 64)), int(arg('width', 34))
FILL, BG = arg('fill'), arg('bg')
BGOP, BGSZ = float(arg('bg-opacity', 80)), float(arg('bg-size', 16))
ALIGN = arg('align')
PRESERVE_STYLE = '--preserve-style' in sys.argv


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


def text_payload(value, text):
    raw = base64.b64decode(value.strip())
    try:
        j = json.loads(raw[8:].decode('utf-16-le'))
    except ValueError:
        return None
    if not isinstance(j, dict) or 'mTextParam' not in j:
        return None
    tp = j['mTextParam']
    ss = tp['mStyleSheet']
    if PRESERVE_STYLE:
        # A style change after character zero indexes the old copy. Its intended new
        # range cannot be inferred from the replacement text.
        if tp.get('mDefaultRun') or not {'mFontName', 'mFontSize', 'mText'} <= ss.keys():
            raise ValueError('unsupported donor style runs')
        for name, style in ss.items():
            if name == 'mText':
                continue
            runs = style.get('mParamValues') if isinstance(style, dict) else None
            if (not isinstance(runs, list) or len(runs) != 1 or not isinstance(runs[0], list)
                    or len(runs[0]) != 2 or runs[0][0] != 0):
                raise ValueError(f'--preserve-style requires a uniform donor style ({name})')
    else:
        ss['mFontName']['mParamValues'] = [[0, FONT]]
        ss['mFontSize']['mParamValues'] = [[0, SIZE]]
        if FILL is not None:
            ss['mFillColor']['mParamValues'] = [[0, int(FILL)]]
        tp['mLeading'] = 0
        if ALIGN is not None:
            tp['mAlignment'] = int(ALIGN)
        if BG is not None:
            tp['mBackFillVisible'] = True
            tp['mBackFillColor'] = int(BG)
            tp['mBackFillOpacity'] = BGOP
            tp['mBackFillSize'] = BGSZ
    ss['mText'] = text
    enc = json.dumps(j, ensure_ascii=False, separators=(',', ':')).encode('utf-16-le')
    return base64.b64encode(struct.pack('<Q', len(enc)) + enc).decode('ascii')


def one(nodes, description):
    if len(nodes) != 1:
        raise ValueError(f'expected one {description}, found {len(nodes)}')
    return nodes[0]


def static_param(root, component, index, param_id, tag):
    ref = one(component.findall(f"./Component/Params/Param[@Index='{index}']"), f'Text parameter {index}')
    object_id = ref.get('ObjectRef', '')
    if not re.fullmatch(r'\d+', object_id):
        raise ValueError(f'invalid Text parameter reference at index {index}')
    one(root.findall(f".//Param[@ObjectRef='{object_id}']"), f'owner of Text parameter {index}')
    param = one(root.findall(f"./{tag}[@ObjectID='{object_id}']"), f'{tag} {object_id}')
    if param.findtext('ParameterID') != param_id or param.findtext('IsTimeVarying') != 'false':
        raise ValueError(f'unsupported or animated Text parameter at index {index}')
    if any('keyframe' in e.tag.lower() and not e.tag.startswith('StartKeyframe') for e in param.iter()):
        raise ValueError(f'additional keyframes in Text parameter at index {index}')
    return param


def replace_value(xml, param, child, value):
    # Preserve the rest of Adobe's XML byte for byte, including other parameters' keyframes.
    tag = param.tag
    object_id = param.attrib['ObjectID']
    pattern = (rf"""(<{tag}\b(?=[^>]*\bObjectID=["']{object_id}["'])[^>]*>"""
               rf'(?:(?!</{tag}>).)*?<{child.tag}\b[^>]*>)[^<]*(</{child.tag}>)')
    xml, count = re.subn(pattern, lambda m: m[1] + value + m[2], xml, flags=re.DOTALL)
    if count != 1:
        raise ValueError(f'cannot write {tag} {object_id}/{child.tag}')
    return xml


def patch_prproj(xml, text, position=None):
    if position is None and not PRESERVE_STYLE:
        def repl(m):
            value = text_payload(m[2], text)
            return m[0] if value is None else m[1] + value + m[3]
        return re.sub(r'(<StartKeyframeValue Encoding="base64"[^>]*>)([^<]+)(</StartKeyframeValue>)', repl, xml)

    root = ET.fromstring(xml)
    component = one(root.findall("./VideoFilterComponent[MatchName='AE.ADBE Text']"), 'AE.ADBE Text layer')
    source = static_param(root, component, '0', '1', 'ArbVideoComponentParam')
    source_value = one(source.findall("./StartKeyframeValue[@Encoding='base64']"), 'Source Text value')
    payload = text_payload(source_value.text or '', text)
    if payload is None:
        raise ValueError('unsupported Source Text payload')
    xml = replace_value(xml, source, source_value, payload)
    if position is None:
        return xml
    point = static_param(root, component, '2', '3', 'PointComponentParam')
    key = one(point.findall('StartKeyframe'), 'Text Position start keyframe')
    fields = (key.text or '').split(',')
    if len(fields) != 15 or not all(math.isfinite(float(n)) for n in fields):
        raise ValueError('unsupported Text Position point keyframe')
    fields[1:3] = [str(number) for number in position]
    return replace_value(xml, point, key, ','.join(fields))


def patch_prgraphic(data, text, position=None):
    buf = io.BytesIO()
    with zipfile.ZipFile(io.BytesIO(data)) as zin, zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as zout:
        if (position is not None or PRESERVE_STYLE) and not any(n.endswith('.prproj') for n in zin.namelist()):
            raise ValueError('missing Premiere project')
        for info in zin.infolist():
            b = zin.read(info)
            if info.filename.endswith('.prproj'):
                xml = gzip.decompress(b).decode('utf-8')
                b = gzip.compress(patch_prproj(xml, text, position).encode('utf-8'))
            zout.writestr(info, b)
    return buf.getvalue()


def make(card, out_dir):
    dst = os.path.join(out_dir, card['id'] + '.mogrt')
    position = None
    if 'textPosition' in card:
        position = card['textPosition']
        if (not isinstance(position, list) or len(position) != 2
                or not all(type(n) in (float, int) and 0 <= n <= 1 for n in position)):
            raise ValueError(f"{card['id']}: textPosition requires two normalized numbers in [0, 1]")
        text = card['text'].replace('\r\n', '\r').replace('\n', '\r')
    else:
        text = wrap(card['text'], WIDTH)

    # A bad localized project must not leave a partially usable card or replace a good one.
    package = io.BytesIO()
    strict = position is not None or PRESERVE_STYLE
    with zipfile.ZipFile(SRC) as zin, zipfile.ZipFile(package, 'w', zipfile.ZIP_DEFLATED) as zout:
        if strict and ('definition.json' not in zin.namelist() or not any(n.endswith('.prgraphic') for n in zin.namelist())):
            raise ValueError(f'{SRC}: expected a Premiere-authored .mogrt with a .prgraphic')
        for info in zin.infolist():
            b = zin.read(info)
            if info.filename == 'definition.json':
                d = json.loads(b.decode('utf-8'))
                d['capsuleID'] = str(uuid.uuid4())
                d['capsuleName'] = card['id']
                for s in d.get('capsuleNameLocalized', {}).get('strDB', []):
                    s['str'] = card['id']
                controls = d.get('clientControls', [])
                if strict:
                    controls = [c for c in controls if c.get('type') == 6]
                    if len(controls) > 1:
                        raise ValueError('ambiguous text controls in definition.json')
                for c in controls:
                    for s in (c.get('value') or {}).get('strDB', []):
                        s['str'] = text
                b = json.dumps(d, ensure_ascii=False).encode('utf-8')
            elif info.filename.endswith('.prgraphic'):
                try:
                    b = patch_prgraphic(b, text, position)
                except (ValueError, ET.ParseError, zipfile.BadZipFile) as exc:
                    raise ValueError(f"{card['id']}: {info.filename}: {exc}") from exc
            elif info.filename.startswith('thumb'):
                continue                       # previews of the stock title; not needed
            zout.writestr(info, b)
    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(dir=out_dir, delete=False) as tmp:
            tmp_path = tmp.name
            tmp.write(package.getbuffer())
        os.replace(tmp_path, dst)
    finally:
        if tmp_path is not None and os.path.exists(tmp_path):
            os.unlink(tmp_path)
    return dst


if __name__ == '__main__':
    style_flags = ('--font', '--size', '--align', '--fill', '--bg', '--bg-opacity', '--bg-size')
    if PRESERVE_STYLE and any(flag in sys.argv for flag in style_flags):
        sys.exit('--preserve-style cannot be combined with font, size, alignment, fill or plate overrides')
    cards = json.load(open(arg('cards'), encoding='utf-8'))
    out = arg('out-dir')
    os.makedirs(out, exist_ok=True)
    for c in cards:
        make(c, out)
    print(f'{len(cards)} cards -> {out}')
