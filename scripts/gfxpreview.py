# Preview a graphics plan WITHOUT After Effects: the plate with a labelled box for every slot, in
# the slot's own frames, so the user approves WHERE and WHAT before anything is built.
#
#   python scripts/gfxpreview.py --plan <gfx-plan.json> --out <preview.mp4> [--sheet <sheet.png>]
#          [--width 1280]
#
# The built-in kit uses its type's zone. For a client kit the boxes indicate layer and timing.
# Exact client layout comes from the AE comp.
import json, os, subprocess, sys, tempfile, textwrap


def arg(k, d=None):
    return sys.argv[sys.argv.index('--' + k) + 1] if '--' + k in sys.argv else d


PLAN, OUT, SHEET, W = arg('plan'), arg('out'), arg('sheet'), int(arg('width', 1280))
if not PLAN or not OUT:
    sys.exit('usage: gfxpreview.py --plan gfx-plan.json --out preview.mp4 [--sheet sheet.png]')
P = json.load(open(PLAN, encoding='utf-8'))
client_kit = 'kit' in P or P['style'] != 'cloudru'
if client_kit:
    cli = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'gfxplan.mjs')
    preview = subprocess.run(['node', cli, 'preview', '--plan', PLAN], stdout=subprocess.PIPE)
    if preview.returncode:
        sys.stderr.buffer.write(preview.stdout)
        sys.exit(preview.returncode)
    mappings = {row['id']: row for row in json.loads(preview.stdout)['mappings']}
S = W / 1920.0
H = int(round(1080 * S / 2) * 2)
# the zone of each type in 1920x1080 px: x, y, w, h (matches the Cloud.ru templates)
ZONE = {'lower_third': (120, 790, 700, 190), 'quote': (120, 770, 1680, 250), 'callout': (1150, 100, 650, 220),
        'logo': (1600, 50, 240, 90), 'chapter': (0, 0, 1920, 1080), 'intro': (0, 0, 1920, 1080), 'outro': (0, 0, 1920, 1080)}
LABEL = {'lower_third': 'ПЛАШКА', 'quote': 'МЫСЛЬ', 'callout': 'ВЫНОСКА', 'logo': 'ЛОГО', 'chapter': 'ГЛАВА',
         'intro': 'ЗАСТАВКА', 'outro': 'КОНЦОВКА'}
FONT = "C\\:/Windows/Fonts/arial.ttf"
tmp = tempfile.mkdtemp(prefix='gfxpreview_')
chain = [f"[0:v]scale={W}:{H},format=yuv420p"]
# drawn in track order, whatever the plan's order: overlays lowest, then the logo, inserts on top
# (gfxcore.pickTracks) — an insert hides the logo in Premiere, so it must here too
ORDER = {'overlay': 0, 'logo': 1, 'insert': 2}
CLIENT_ZONE = {'overlay': ZONE['lower_third'], 'logo': ZONE['logo'], 'insert': ZONE['chapter']}
active = sorted((x for x in P['slots'] if not x.get('lost')), key=lambda x: ORDER.get(x['layer'], 0))
for k, s in enumerate(active):
    zone = CLIENT_ZONE[s['layer']] if client_kit else ZONE[s['type']]
    x, y, w, h = (int(round(v * S)) for v in zone)
    full = s['layer'] == 'insert'
    en = f"enable='between(n,{s['in']},{s['out'] - 1})'"
    chain.append(f"drawbox=x={x}:y={y}:w={w}:h={h}:color={'0x343F48@0.93' if full else 'black@0.55'}:t=fill:{en}")
    if not full:
        chain.append(f"drawbox=x={x}:y={y}:w={w}:h={h}:color=0x26D07C:t=3:{en}")
    if client_kit:
        mapping = mappings[s['id']]
        lines = [f"{s['id']} · {mapping['visualRole']}"]
        values = [field['value'] for field in mapping['fields']]
    else:
        lines = [f"{LABEL[s['type']]} · {s['id']}"]
        values = (s.get('text') or {}).values()
    for v in values:
        for part in str(v).split('\n'):
            lines += textwrap.wrap(part, 34 if full else 42) or ['']
    fs = max(14, int(round(26 * S * (1.6 if full else 1.0))))
    tx, ty = (int(160 * S), int(420 * S)) if full else (x + int(40 * S), y + int(30 * S))
    # One drawtext per line: ffmpeg 8's drawtext draws a line break as a missing-glyph box at the
    # end of the line (with \r\n from Python on Windows it adds an empty line as well).
    for li, line in enumerate(lines):
        if not line.strip():
            continue
        name = f"t{k}_{li}.txt"
        with open(os.path.join(tmp, name), 'w', encoding='utf-8', newline='') as f:
            f.write(line)
        chain.append(f"drawtext=fontfile='{FONT}':textfile={name}:expansion=none:fontsize={fs}:fontcolor=white:x={tx}:y={ty + li * int(fs * 1.4)}:{en}")
graph = os.path.join(tmp, 'graph.txt')
with open(graph, 'w', encoding='utf-8') as f:
    f.write(','.join(chain) + '[v]')
subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', P['plate'], '-/filter_complex', graph, '-map', '[v]', '-map', '0:a?',
                '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-c:a', 'aac', '-b:a', '128k', os.path.abspath(OUT)],
               check=True, cwd=tmp)
if SHEET and active:
    mids = sorted({(s['in'] + s['out']) // 2 for s in active})
    cols = min(4, len(mids)); rows = (len(mids) + cols - 1) // cols
    sel = '+'.join(f"eq(n\\,{m})" for m in mids)
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', os.path.abspath(OUT), '-vf', f"select='{sel}',scale=480:-2,tile={cols}x{rows}",
                    '-frames:v', '1', '-fps_mode', 'vfr', os.path.abspath(SHEET)], check=True)
print(json.dumps({'ok': True, 'out': os.path.abspath(OUT), 'sheet': os.path.abspath(SHEET) if SHEET and active else None,
                  'slots': len(P['slots'])}, ensure_ascii=False))
