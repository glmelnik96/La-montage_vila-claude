# Make a Premiere FCP XML carry every video clip at its file's natural size, for grading.
# Premiere writes a pixel-aspect override (Interpret Footage, e.g. PAR 1.333 on an anamorphic file that is square
# in itself) as a transform: Basic Motion Scale 133.333 plus a Distort filter (Aspect -33.33) on each clipitem, and
# pixelaspectratio «HD-(1440x1080)» on the file and the clipitem. Resolve would apply that sizing. This drops every
# Distort, resets Basic Motion to Scale 100 (drops the filter when nothing else is left in it), and puts back the
# file's own pixel aspect (pproOriginalPAR) on the file and its clipitems. Also collapses the double slash Premiere
# writes after the drive for some paths, and puts back each file's own timecode where Premiere wrote another (Sony
# XAVC sidecars count 25 fps frames for 50p). Reports what it changed.
#   python scripts/gradexmlfix.py <in.xml> <out.xml>
import json, re, subprocess, sys, urllib.parse
import xml.etree.ElementTree as ET
sys.stdout.reconfigure(encoding='utf-8')
src, dst = sys.argv[1], sys.argv[2]
tree = ET.parse(src)
root = tree.getroot()
seq = root.find('.//sequence')
orig = {}                                                    # file id -> its own PAR
for f in root.iter('file'):
    sc = f.find('media/video/samplecharacteristics')
    if sc is None: continue
    own = sc.findtext('pproOriginalPAR')
    if own and sc.findtext('pixelaspectratio') != own:
        orig[f.get('id')] = own
        sc.find('pixelaspectratio').text = own
        if sc.find('anamorphic') is not None and sc.findtext('pproOriginalIsAnamorphic'):
            sc.find('anamorphic').text = sc.findtext('pproOriginalIsAnamorphic')
# Premiere keeps some paths as «D:\GCT …» and writes them «file://localhost/D%3a//GCT …»: one slash after the drive
fixed_urls = 0
for pu in root.iter('pathurl'):
    t = re.sub(r'^(file://localhost/[A-Za-z]%3[aA])/{2,}', lambda m: m.group(1) + '/', pu.text or '')
    if t != pu.text: pu.text = t; fixed_urls += 1
# A Sony XAVC sidecar counts its timecode in 25 fps frames even for 50p («tcFps=25 halfStep»), and Premiere wrote that
# count into a 50p <timecode> (00:34:21:15 for the file's own 00:34:21:30). Resolve conforms by timecode, so those clips
# came out 15 frames early (2026-10-28). Put each file's own timecode track back when it differs.
fixed_tc = []
for f in root.iter('file'):
    pu, tc = f.findtext('pathurl'), f.find('timecode')
    if not pu or tc is None or tc.find('string') is None: continue
    p = urllib.parse.unquote(pu.replace('file://localhost/', ''))
    pr = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format_tags=timecode:stream_tags=timecode', '-of', 'json', p], capture_output=True, text=True)
    try:
        j = json.loads(pr.stdout)
    except ValueError:
        continue
    own = (j.get('format', {}).get('tags', {}) or {}).get('timecode') or next((s['tags']['timecode'] for s in j.get('streams', []) if (s.get('tags') or {}).get('timecode')), None)
    tb = int(tc.findtext('rate/timebase') or 0)
    if not own or not tb or own.replace(';', ':') == tc.findtext('string').replace(';', ':'): continue
    h, mi, s_, fr = map(int, re.split('[:;]', own))
    if fr >= tb: continue
    old = tc.findtext('string')
    tc.find('string').text = own
    if tc.find('frame') is not None: tc.find('frame').text = str(((h * 60 + mi) * 60 + s_) * tb + fr)
    fixed_tc.append(f"{p.split('/')[-1]} {old} -> {own}")
changed, names = 0, set()
for tr in seq.find('media/video').findall('track'):
    for ci in tr.findall('clipitem'):
        fid = ci.find('file').get('id')
        did = False
        for fl in list(ci.findall('filter')):
            ef = fl.find('effect'); en = ef.findtext('name') if ef is not None else ''
            if en == 'Distort':
                ci.remove(fl); did = True
            elif en == 'Basic Motion':
                params = ef.findall('parameter')
                for p in params:
                    if p.findtext('parameterid') == 'scale' and p.findtext('value') not in ('100', '100.0'):
                        p.find('value').text = '100'; did = True
                rest = [p for p in params if p.findtext('parameterid') != 'scale']
                if not rest: ci.remove(fl); did = True
        if fid in orig:
            if ci.find('pixelaspectratio') is not None: ci.find('pixelaspectratio').text = orig[fid]
            if ci.find('anamorphic') is not None: ci.find('anamorphic').text = 'FALSE'
            did = True
        if did: changed += 1; names.add(ci.findtext('name'))
body = ET.tostring(root, encoding='unicode')
with open(dst, 'w', encoding='utf-8', newline='\n') as fh:
    fh.write('<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE xmeml>\n' + body + '\n')
print(f'{src} -> {dst}: file timecodes put back to the files own: {fixed_tc or "none"};')
print(f'  {fixed_urls} media paths with one slash after the drive; {len(orig)} files back to their own pixel aspect, {changed} clipitems at natural size ({", ".join(sorted(names)[:6])}{"…" if len(names) > 6 else ""})')
