# Check an FCP XML export against its grading plan: every video clipitem (start/end/in/out in
# frames), media paths, audio clipitems, markers, and the source files' resolution and timecode.
#   python scripts/gradexmlcheck.py <export.xml> <plan.json>   (plan from gradexml.mjs)
import json, sys, urllib.parse
import xml.etree.ElementTree as ET
sys.stdout.reconfigure(encoding='utf-8')
xmlp, planp = sys.argv[1], sys.argv[2]
plan = json.load(open(planp, encoding='utf-8'))
root = ET.parse(xmlp).getroot()
seq = root.find('.//sequence')
tb = int(seq.find('rate/timebase').text)
files = {}
for f in root.iter('file'):
    if f.find('pathurl') is not None:
        sc = f.find('media/video/samplecharacteristics')
        files[f.get('id')] = {
            'path': urllib.parse.unquote(f.find('pathurl').text),
            'wh': (sc.find('width').text, sc.find('height').text) if sc is not None else None,
            'tc': f.findtext('timecode/string'), 'rate': f.findtext('rate/timebase')}
vids, auds = [], 0
for tr in seq.find('media/video').findall('track'):
    for ci in tr.findall('clipitem'):
        fid = ci.find('file').get('id')
        vids.append((ci.findtext('name'), int(ci.findtext('start')), int(ci.findtext('end')), int(ci.findtext('in')), int(ci.findtext('out')), fid))
aud = seq.find('media/audio')
if aud is not None:
    for tr in aud.findall('track'):
        auds += len(tr.findall('clipitem'))
marks = seq.findall('marker')
want = sorted(plan['rows'], key=lambda r: r['gs'])
errs = []
if len(vids) != len(want): errs.append(f'{len(vids)} video clipitems, plan {len(want)}')
for w, g in zip(want, sorted(vids, key=lambda v: v[1])):
    exp = (round(w['gs'] * tb), round(w['ge'] * tb), round(w['sIn'] * tb), round((w['sIn'] + w['ge'] - w['gs']) * tb))
    if g[0] != w['name'] or (g[1], g[2], g[3], g[4]) != exp:
        errs.append(f"{w['id']}: want {w['name']} {exp}, xml {g[:5]}")
paths = sorted({files[v[5]]['path'] for v in vids if v[5] in files})
nonbraw = [p for p in paths if not p.lower().endswith('.braw')]
print(f"{xmlp.split('/')[-1]}: timebase {tb}, {len(vids)} video clips, {auds} audio clips, {len(marks)} markers, {len(paths)} source files")
print('  resolutions:', sorted({files[v[5]]['wh'] for v in vids if v[5] in files}), ' rates:', sorted({files[v[5]]['rate'] for v in vids if v[5] in files}))
print('  first sources:', '; '.join(f"{p.split('/')[-1]} tc {next(x['tc'] for x in files.values() if x['path'] == p)}" for p in paths[:3]))
print('  ' + ('every clip matches the plan frame for frame; all sources .braw' if not errs and not nonbraw and auds == 0
              else 'PROBLEMS: ' + '; '.join(errs[:6] + [f'non-BRAW: {nonbraw}'] * bool(nonbraw) + [f'{auds} audio clips'] * bool(auds))))
sys.exit(1 if errs or nonbraw or auds else 0)
