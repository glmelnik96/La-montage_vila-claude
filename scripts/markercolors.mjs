// Colour a sequence's markers from a markers file (matched by name + time) and read the
// colours back. The panel host's marker call ignores `color`: on host 2.17.0 every marker
// added through `pr.mjs markers` comes out green, whatever the payload says. Safe to re-run.
//
//   node scripts/markercolors.mjs --file markers.json --seq "<active sequence name>"
//
// markers.json: [{ "timeSec": N, "name": "...", "color": 0-7 }, ...]
// Premiere marker colour index: 0 green, 1 red, 2 purple, 3 orange, 4 yellow, 5 white,
// 6 blue, 7 cyan. Names travel inside the JSX source, which must stay free of
// backslashes, so a name containing `"` or `\` is refused.
import { readFileSync } from 'node:fs';
import { callBridge } from './lib/prbridge.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const SEQ = arg('seq');
const P = JSON.parse(readFileSync(arg('file'), 'utf8')).map((m) => ({ t: m.timeSec, n: m.name, c: m.color | 0 }));
const bad = P.filter((m) => /["\\]/.test(m.n));
if (!SEQ || bad.length) { console.error(!SEQ ? 'usage: --file <json> --seq <name>' : `names with " or \\: ${bad.map((m) => m.n)}`); process.exit(2); }

const code = `(function(){try{
  var s=app.project.activeSequence; if(String(s.name)!==${JSON.stringify(SEQ)}) return JSON.stringify({error:'active is '+s.name});
  var P=${JSON.stringify(P)}, m=s.markers, k=m.getFirstMarker(), n=0, set=0, miss=[], by={};
  while(k && n<5000){
    var nm=String(k.name), t=k.start.seconds, hit=-1, i, c;
    for(i=0;i<P.length;i++){ if(P[i].n===nm && Math.abs(P[i].t-t)<0.06){ hit=i; break; } }
    if(hit<0) miss.push(nm+' @'+Math.round(t*100)/100); else { k.setColorByIndex(P[hit].c); set++; }
    c=k.getColorByIndex(); by[c]=(by[c]||0)+1;
    n++; k=m.getNextMarker(k);
  }
  return JSON.stringify({markers:n, coloured:set, unmatched:miss.slice(0,20), byColour:by});
}catch(e){return JSON.stringify({error:String(e),line:e.line});}})()`;
const r = await callBridge('evalJson', [code], { timeoutMs: 30000 });
console.log(typeof r === 'string' ? r : JSON.stringify(r));
