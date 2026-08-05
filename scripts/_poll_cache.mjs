// Poll the transcript cache until a given seqId has segments. Prints status lines.
// Usage: node scripts/_poll_cache.mjs <seqId> [maxMinutes]
import { readFileSync } from 'fs';
import { loadConfig } from './lib/config.mjs';

const seqId = process.argv[2];
const maxMin = Number(process.argv[3] || 90);
const minLastEnd = Number(process.argv[4] || 0); // require segments to extend past this time
if (!seqId) { console.error('usage: _poll_cache.mjs <seqId> [maxMinutes]'); process.exit(2); }
const cfg = loadConfig();
const start = Date.now();
const deadline = start + maxMin * 60000;

function check() {
  try {
    const o = JSON.parse(readFileSync(cfg.transcriptCachePath, 'utf8'));
    const e = o[seqId];
    if (e && Array.isArray(e.segments) && e.segments.length > 0) {
      const last = e.segments[e.segments.length - 1];
      if (last.endSec >= minLastEnd) {
        return { done: true, segs: e.segments.length, lastEnd: last.endSec, name: e.seqName };
      }
    }
  } catch {}
  return { done: false };
}

(async () => {
  while (Date.now() < deadline) {
    const r = check();
    const mins = ((Date.now() - start) / 60000).toFixed(1);
    if (r.done) {
      console.log(`DONE @${mins}min: seqId=${seqId} name=${r.name} segments=${r.segs} lastEnd=${r.lastEnd}s`);
      process.exit(0);
    }
    console.log(`waiting... ${mins}min elapsed, no segments yet`);
    await new Promise((res) => setTimeout(res, 30000));
  }
  console.log(`TIMEOUT after ${maxMin}min — no segments for ${seqId}`);
  process.exit(1);
})();
