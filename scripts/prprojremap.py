# Give clips their original Time Remapping again, in a saved (and CLOSED) Premiere project: the DOM and QE cannot see or
# set time remapping, so the keyframes are copied in the project file itself.
#   python scripts/prprojremap.py <project.prproj> <jobs.json>
# jobs.json: [{"target": "<media file name of the clip that is in the timeline now>",
#              "media": "<media file name to put under it: a graded file on the source's own time (gradeconform.py)>",
#              "remap_from": "<media file name of the original source>", "in": <original in, ticks>, "out": <original out, ticks>}]
# Per job: the target's timeline clip (the VideoClip on the target's VideoMediaSource that has an InPoint) gets the new
# media's source, the original clip's InPoint/OutPoint (remapped clip time) and a TimeRemapping that is a copy of the
# original's (new ObjectIDs); its SubClip gets the new media's MasterClip and name. Everything else stays byte for byte.
# Object IDs repeat across classes in a .prproj: every lookup names the class.
import gzip, json, re, shutil, sys
sys.stdout.reconfigure(encoding='utf-8')
path, jobsp = sys.argv[1:3]
jobs = json.load(open(jobsp, encoding='utf-8'))
x = gzip.open(path).read().decode('utf-8')
TPS = 254016000000


def span(tag, oid):
    m = re.search(r'<%s Object(?:ID|UID)="%s"[^>]*>' % (tag, re.escape(oid)), x)
    if not m: raise SystemExit(f'no {tag} {oid}')
    return m.start(), x.index('</%s>' % tag, m.start()) + len(tag) + 3


def body(tag, oid):
    a, b = span(tag, oid); return x[a:b]


def owner(i):
    return [mm for mm in re.finditer(r'<(\w+) Object(?:ID|UID)="([^"]+)"', x[:i])][-1].groups()


def video_sources(name):
    """every VideoMediaSource ID of a media file (a file imported more than once has several Media objects)"""
    ms = [owner(m.start()) for m in re.finditer(r'<ActualMediaFilePath>[^<]*[\\/]' + re.escape(name) + '<', x)]
    out = []
    for m in [m for m in ms if m[0] == 'Media']:
        out += [o[1] for o in (owner(r.start()) for r in re.finditer(r'<Media ObjectURef="%s"/>' % m[1], x)) if o[0] == 'VideoMediaSource']
    return out


def media_source(name):
    """the VideoMediaSource ID, its clips and the MasterClip UID of a media file imported once"""
    vs = video_sources(name)
    if len(vs) != 1: raise SystemExit(f'{name}: {len(vs)} video sources')
    sid = vs[0]
    clips = [owner(r.start()) for r in re.finditer(r'<Source ObjectRef="%s"/>' % sid, x)]
    master_vc = [c for c in clips if c[0] == 'VideoClip' and '<InPoint>' not in body('VideoClip', c[1])]
    mcs = []
    for c in master_vc:
        for r in re.finditer(r'ObjectRef="%s"/>' % c[1], x):
            o = owner(r.start())
            if o[0] == 'MasterClip': mcs.append(o[1])
    return sid, clips, (mcs[0] if mcs else None)


ids = [int(v) for v in re.findall(r' ObjectID="(\d+)"', x)]
nxt = max(ids) + 1
edits, adds = [], []
for j in jobs:
    s_t, clips_t, _ = media_source(j['target'])
    tl = [c for c in clips_t if c[0] == 'VideoClip' and '<InPoint>' in body('VideoClip', c[1])]
    if len(tl) != 1: raise SystemExit(f"{j['target']}: {len(tl)} timeline clips")
    vc = tl[0][1]
    subs = [owner(r.start()) for r in re.finditer(r'<Clip ObjectRef="%s"/>' % vc, x)]
    subs = [s for s in subs if s[0] == 'SubClip']
    if len(subs) != 1: raise SystemExit(f"{j['target']}: {len(subs)} subclips")
    s_n, clips_n, mc_n = media_source(j['media'])
    if not mc_n: raise SystemExit(f"{j['media']}: no master clip (import it and save first)")
    # the original remapped clip: on the source of remap_from, with a TimeRemapping and the original in/out
    clips_o = [owner(r.start()) for sid in video_sources(j['remap_from']) for r in re.finditer(r'<Source ObjectRef="%s"/>' % sid, x)]
    orig = None
    for c in clips_o:
        if c[0] != 'VideoClip': continue
        b = body('VideoClip', c[1]); tr = re.search(r'<TimeRemapping ObjectRef="(\d+)"/>', b)
        ip = re.search(r'<InPoint>(\d+)<', b); op = re.search(r'<OutPoint>(\d+)<', b)
        if tr and ip and abs(int(ip.group(1)) - j['in']) < 100 and abs(int(op.group(1)) - j['out']) < 100:
            orig = (c[1], tr.group(1), int(ip.group(1)), int(op.group(1)))
            break
    if not orig: raise SystemExit(f"{j['remap_from']}: no remapped clip with in {j['in']}")
    trb = body('TimeRemapping', orig[1]); kf = re.search(r'<Keyframes ObjectRef="(\d+)"/>', trb).group(1); kfb = body('TimeComponentParam', kf)
    new_tr, new_kf = str(nxt), str(nxt + 1); nxt += 2
    adds.append(re.sub(r'ObjectID="%s"' % orig[1], 'ObjectID="%s"' % new_tr, trb, 1).replace('ObjectRef="%s"' % kf, 'ObjectRef="%s"' % new_kf))
    adds.append(re.sub(r'ObjectID="%s"' % kf, 'ObjectID="%s"' % new_kf, kfb, 1))
    # the timeline clip: new source + the remap + the original in/out
    a, b = span('VideoClip', vc); v = x[a:b]
    v2 = v.replace('<Source ObjectRef="%s"/>' % s_t, '<Source ObjectRef="%s"/>\n\t\t\t<TimeRemapping ObjectRef="%s"/>' % (s_n, new_tr), 1)
    mvc = [c for c in clips_n if c[0] == 'VideoClip' and '<InPoint>' not in body('VideoClip', c[1])]
    mk = re.search(r'<Markers ObjectRef="(\d+)"/>', body('VideoClip', mvc[0][1])) if mvc else None
    if mk: v2 = re.sub(r'<Markers ObjectRef="\d+"/>', '<Markers ObjectRef="%s"/>' % mk.group(1), v2, 1)   # the new master's clip markers
    v2 = re.sub(r'<OutPoint>\d+</OutPoint>', '<OutPoint>%d</OutPoint>' % orig[3], v2, 1)
    v2 = re.sub(r'<InPoint>\d+</InPoint>', '<InPoint>%d</InPoint>' % orig[2], v2, 1)
    assert v2 != v and '<TimeRemapping' in v2
    edits.append((a, b, v2))
    a, b = span('SubClip', subs[0][1]); sbody = x[a:b]
    s2 = re.sub(r'<MasterClip ObjectURef="[^"]+"/>', '<MasterClip ObjectURef="%s"/>' % mc_n, sbody, 1)
    s2 = re.sub(r'<Name>[^<]*</Name>', '<Name>%s</Name>' % j['media'], s2, 1)
    edits.append((a, b, s2))
    print(f"{j['target']}: VideoClip {vc} -> source {s_n} ({j['media']}), in/out {orig[2] / TPS:.3f}-{orig[3] / TPS:.3f}, "
          f"remap copied from VideoClip {orig[0]} (TimeRemapping {orig[1]} -> {new_tr}, keys {kf} -> {new_kf}); SubClip {subs[0][1]} -> master {mc_n}")
for a, b, new in sorted(edits, reverse=True):
    x = x[:a] + new + x[b:]
end = x.rindex('</PremiereData>')
x = x[:end] + '\n'.join(adds) + '\n' + x[end:]
tmp = path + '.tmp'
with gzip.open(tmp, 'wb') as fh: fh.write(x.encode('utf-8'))
shutil.move(tmp, path)
print('written', path)
