# Check an FCP XML export against its grading plan: every video clipitem (start/end/in/out in
# frames), media paths, audio clipitems, markers, and the source files' resolution and timecode.
# Also what the grade must not carry: transitions, a speed (Time Remap), any filter but a default
# Basic Motion (Scale 100, centred, no rotation) and Opacity 100; and each file's pixel aspect.
#   python scripts/gradexmlcheck.py <export.xml> <plan.json> [--media "\.braw$"]   (plan from gradexml.mjs)
# A clipitem counts its in/out in its own timebase; a file of another rate (a 29.97 phone clip in a 50p
# sequence) lands on its own frame first, so its in/out may sit one source frame + one frame off the plan.
import json, re, sys, urllib.parse
import xml.etree.ElementTree as ET
sys.stdout.reconfigure(encoding='utf-8')
xmlp, planp = sys.argv[1], sys.argv[2]
media_re = re.compile(sys.argv[sys.argv.index('--media') + 1] if '--media' in sys.argv else r'\.braw$', re.I)
plan = json.load(open(planp, encoding='utf-8'))
root = ET.parse(xmlp).getroot()
seq = root.find('.//sequence')
tb = int(seq.find('rate/timebase').text)


def rate(el):
    t = el.findtext('rate/timebase')
    if t is None: return None
    return int(t) * (1000 / 1001 if el.findtext('rate/ntsc') == 'TRUE' else 1)


files = {}
for f in root.iter('file'):
    if f.find('pathurl') is not None:
        sc = f.find('media/video/samplecharacteristics')
        files[f.get('id')] = {
            'path': urllib.parse.unquote(f.find('pathurl').text),
            'wh': (sc.find('width').text, sc.find('height').text) if sc is not None else None,
            'par': (sc.findtext('pixelaspectratio') if sc is not None else None),
            'anam': (sc.findtext('anamorphic') if sc is not None else None),
            'tc': f.findtext('timecode/string'), 'rate': f.findtext('rate/timebase'), 'fps': rate(f)}
vids, auds, notes = [], 0, []
vt = seq.find('media/video').findall('track')
trans = sum(len(t.findall('transitionitem')) for t in vt)
for tr in vt:
    for ci in tr.findall('clipitem'):
        fid = ci.find('file').get('id')
        nm = ci.findtext('name')
        for fl in ci.findall('filter'):
            ef = fl.find('effect'); en = ef.findtext('name') if ef is not None else '?'
            pv = {p.findtext('parameterid'): p.find('value') for p in (ef.findall('parameter') if ef is not None else [])}
            if en == 'Basic Motion':
                sc = pv.get('scale'); rot = pv.get('rotation'); cen = pv.get('center')
                s_ = float(sc.text) if sc is not None and sc.text else 100.0
                r_ = float(rot.text) if rot is not None and rot.text else 0.0
                c_ = (float(cen.findtext('horiz') or 0), float(cen.findtext('vert') or 0)) if cen is not None else (0.0, 0.0)
                if abs(s_ - 100) > 1e-3 or abs(r_) > 1e-3 or max(map(abs, c_)) > 1e-4: notes.append(f'{nm}: Basic Motion scale {s_} rotation {r_} center {c_}')
            elif en == 'Opacity':
                op = pv.get('opacity')
                if op is not None and op.text and abs(float(op.text) - 100) > 1e-3: notes.append(f'{nm}: Opacity {op.text}')
            else:
                notes.append(f'{nm}: filter {en}')
        cr = rate(ci) or tb
        vids.append((nm, int(ci.findtext('start')), int(ci.findtext('end')), int(ci.findtext('in')), int(ci.findtext('out')), fid, cr))
aud = seq.find('media/audio')
if aud is not None:
    for tr in aud.findall('track'):
        auds += len(tr.findall('clipitem'))
marks = seq.findall('marker')
want = sorted(plan['rows'], key=lambda r: r['gs'])
errs = []
if len(vids) != len(want): errs.append(f'{len(vids)} video clipitems, plan {len(want)}')
for w, g in zip(want, sorted(vids, key=lambda v: v[1])):
    cr = g[6]
    exp = (round(w['gs'] * tb), round(w['ge'] * tb))
    exin = (w['sIn'] * cr, (w['sIn'] + w['ge'] - w['gs']) * cr)
    ff = files.get(g[5], {}).get('fps') or cr
    tol = cr / ff + 1.01 if abs(ff - cr) > 1e-3 else 0.01  # a file of another rate snaps to its own frames, then the grid
    if g[0] != w['name'] or (g[1], g[2]) != exp or abs(g[3] - exin[0]) > tol or abs(g[4] - exin[1]) > tol + 1:
        errs.append(f"{w['id']}: want {w['name']} {exp} in/out {exin[0]:.2f}/{exin[1]:.2f} @{cr:.3f}, xml {g[:5]}")
paths = sorted({files[v[5]]['path'] for v in vids if v[5] in files})
other = [p for p in paths if not media_re.search(p)]
used = {v[5] for v in vids}
pars = {}
for fid, f in files.items():
    if fid in used: pars.setdefault((f['par'], f['anam']), []).append(f['path'].split('/')[-1])
print(f"{xmlp.split('/')[-1]}: timebase {tb}, {len(vids)} video clips, {auds} audio clips, {trans} transitions, {len(marks)} markers, {len(paths)} source files")
print('  resolutions:', sorted({files[v[5]]['wh'] for v in vids if v[5] in files}), ' rates:', sorted({str(files[v[5]]['fps'] and round(files[v[5]]['fps'], 3)) for v in vids if v[5] in files}))
for (par, anam), names in sorted(pars.items(), key=lambda x: -len(x[1])):
    print(f'  pixel aspect «{par}» anamorphic «{anam}»: {len(names)} files, e.g. {", ".join(sorted(names)[:4])}')
print('  first sources:', '; '.join(f"{p.split('/')[-1]} tc {next(x['tc'] for x in files.values() if x['path'] == p)}" for p in paths[:3]))
bad = errs + [f'other media: {other}'] * bool(other) + [f'{auds} audio clips'] * bool(auds) + [f'{trans} transitions'] * bool(trans) + notes
print('  ' + ('every clip matches the plan frame for frame; all sources match the media pattern; no audio, transitions, speed or filters; Scale 100'
              if not bad else 'PROBLEMS: ' + '; '.join(bad[:10])))
sys.exit(1 if bad else 0)
