# premiere-autopilot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a thin Claude Code skill that drives a live Adobe Premiere Pro (via the LLM-Chat_Pr CEP panel's CDP debug port) to perform turnkey podcast/interview montage + vertical reels, and generates/inserts AI assets via the Phygital sidecar.

**Architecture:** Claude runs Node CLI helpers over Bash. `pr.mjs` connects to the panel's Chrome DevTools port (8098) and invokes the already-loaded `window.PremiereBridge` methods (which wrap ExtendScript). `gen.mjs` talks HTTP to the Phygital sidecar (127.0.0.1:8765). `preflight.mjs` verifies/starts both. All heavy logic is reused from the two source repos; the skill only orchestrates. `SKILL.md` teaches Claude the montage workflow (approval model B: semi-auto, one backup, confirm only paid generations).

**Tech Stack:** Node.js (built-in `fetch`, `WebSocket`, `child_process`), Chrome DevTools Protocol, Windows `schtasks` (MSIX desandbox), Phygital FastAPI sidecar HTTP API.

**Environment note (Windows/MSIX):** Claude Code here runs MSIX-sandboxed. Processes spawned from Bash see a virtualized `%LOCALAPPDATA%`. The sidecar must therefore be launched OUTSIDE the container via `schtasks` so it reads the user's real `session.json`/`sidecar.token`. HTTP over localhost is unaffected. The transcript cache lives at `%USERPROFILE%\.extensions_llm_chat_pr\` (profile root, not virtualized) and is readable directly.

**Reused interfaces (do NOT edit source repos):**
- Panel global `window.PremiereBridge` (callback API) — see `Extensions-LLM-Chat_Pr/client/shared/bridge-premiere.js`. Methods: `getTimelineSnapshot(cb)`, `backupActiveSequence(cb)`, `activateSequenceById(id,cb)`, `applyTimecodeEdits(plan,cb)`, `applyTranscriptCuts(cuts,cb)`, `addSequenceMarkers(arr,cb)`, `prepareTranscribeFromTimeline(params,cb)`, `getVerticalReframeSources(cb)`, `applyVerticalReframe(plan,cb)`, `importMediaFile(params,cb)`, `importAndOverlayOnTop(payload,cb)`, `activateSequenceByName(payload,cb)`, `setPlayhead(sec,cb)`.
- CDP eval pattern — see `Extensions-LLM-Chat_Pr/tools/cep-debug.mjs`.
- Sidecar HTTP — see `Phygital-Adobe-Studio/sidecar/README.md`. Auth header `X-Phygital-Sidecar-Token`; `/health` public.

---

## File Structure

```
Edit_Skill/
├── SKILL.md                    # orchestration workflow (Task 9)
├── config.json                 # repo paths + ports (Task 1)
├── scripts/
│   ├── lib/
│   │   ├── cdp.mjs             # CDP connect + eval one expression (Task 2)
│   │   ├── prbridge.mjs        # build PremiereBridge promise-expr + run via cdp (Task 3)
│   │   └── config.mjs          # load config.json, resolve paths (Task 1)
│   ├── preflight.mjs          # check/start panel + sidecar + auth (Task 8)
│   ├── pr.mjs                 # Premiere command CLI (Tasks 3-6)
│   └── gen.mjs                # Phygital generation CLI (Task 7)
└── docs/superpowers/{specs,plans}/   # already exists
```

Each file has one responsibility. `pr.mjs`/`gen.mjs` are command dispatchers; real logic lives in `lib/`.

---

### Task 1: Skill scaffolding — config + config loader

**Files:**
- Create: `Edit_Skill/config.json`
- Create: `Edit_Skill/scripts/lib/config.mjs`

- [ ] **Step 1: Write `config.json`**

```json
{
  "cdpPort": 8098,
  "sidecarBaseUrl": "http://127.0.0.1:8765",
  "repos": {
    "llmChatPr": "C:/Users/Глеб/Documents/Extensions-LLM-Chat_Pr",
    "phygital": "C:/Users/Глеб/Documents/Phygital-Adobe-Studio"
  },
  "transcriptCachePath": "C:/Users/Глеб/.extensions_llm_chat_pr/_llm_transcript_cache.json",
  "sidecarTokenPath": "C:/Users/Глеб/AppData/Local/PhygitalStudio/sidecar.token",
  "sidecarAppDir": "C:/Users/Глеб/Documents/Phygital-Adobe-Studio/sidecar",
  "pythonExe": "python"
}
```

- [ ] **Step 2: Write `scripts/lib/config.mjs`**

```javascript
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(here, '..', '..', 'config.json');

export function loadConfig() {
  const cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  if (!cfg.cdpPort || !cfg.sidecarBaseUrl) {
    throw new Error('config.json missing cdpPort or sidecarBaseUrl');
  }
  return cfg;
}
```

- [ ] **Step 3: Verify it loads**

Run: `node -e "import('./scripts/lib/config.mjs').then(m=>console.log(m.loadConfig().cdpPort))"` (cwd = `Edit_Skill`)
Expected: prints `8098`

- [ ] **Step 4: Commit** (skip — not a git repo; note completion instead)

---

### Task 2: CDP library — connect and eval one expression

**Files:**
- Create: `Edit_Skill/scripts/lib/cdp.mjs`

This adapts the eval pattern from `Extensions-LLM-Chat_Pr/tools/cep-debug.mjs` (lines 24-60). It finds the panel page target on the debug port and runs one `Runtime.evaluate` with `returnByValue` + `awaitPromise`.

- [ ] **Step 1: Write `scripts/lib/cdp.mjs`**

```javascript
// Connect to the CEP panel's Chrome DevTools port and evaluate one JS expression.
// Mirrors Extensions-LLM-Chat_Pr/tools/cep-debug.mjs (do not edit that file).

export async function getPageTarget(port) {
  let targets;
  try {
    const res = await fetch(`http://localhost:${port}/json`);
    targets = await res.json();
  } catch (e) {
    throw new Error(`CDP port ${port} unreachable — is Premiere open with the "ИИ: монтаж" panel? (${e.message})`);
  }
  const page = targets.find((t) => t.type === 'page');
  if (!page) throw new Error(`No page target on port ${port} (panel closed?)`);
  return page;
}

export function cdpEval(wsUrl, expression, { awaitPromise = true, timeoutMs = 130000 } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error(`CDP timeout ${timeoutMs}ms`));
    }, timeoutMs);
    ws.onerror = (e) => { clearTimeout(timer); reject(new Error('WS error: ' + (e.message || e))); };
    ws.onopen = () => {
      ws.send(JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: { expression, returnByValue: true, awaitPromise }
      }));
    };
    ws.onmessage = (msg) => {
      let data;
      try { data = JSON.parse(msg.data); } catch { return; }
      if (data.id !== 1) return;
      clearTimeout(timer);
      ws.close();
      if (data.error) { reject(new Error('CDP: ' + JSON.stringify(data.error))); return; }
      const r = data.result || {};
      if (r.exceptionDetails) {
        const ex = r.exceptionDetails;
        reject(new Error('Panel exception: ' + (ex.exception?.description || ex.text)));
        return;
      }
      resolve(r.result?.value);
    };
  });
}

export async function evalInPanel(port, expression, opts) {
  const page = await getPageTarget(port);
  return cdpEval(page.webSocketDebuggerUrl, expression, opts);
}
```

- [ ] **Step 2: Smoke test against the live panel**

Run: `node -e "import('./scripts/lib/cdp.mjs').then(m=>m.evalInPanel(8098,'document.title')).then(console.log)"` (cwd = `Edit_Skill`, Premiere + panel open)
Expected: prints the panel document title (non-empty string). If Premiere is closed, expect the "CDP port 8098 unreachable" error — that is also a valid confirmation the error path works.

- [ ] **Step 3: Commit** (note completion — not a git repo)

---

### Task 3: PremiereBridge wrapper + `pr.mjs snapshot` and `backup`

**Files:**
- Create: `Edit_Skill/scripts/lib/prbridge.mjs`
- Create: `Edit_Skill/scripts/pr.mjs`

`callBridge(method, args)` builds an expression that invokes `window.PremiereBridge[method](...args, cb)` and resolves a JSON string `{ok, error, data}`.

- [ ] **Step 1: Write `scripts/lib/prbridge.mjs`**

```javascript
import { evalInPanel } from './cdp.mjs';
import { loadConfig } from './config.mjs';

// Build a JS expression (run in the panel) that calls a callback-style
// PremiereBridge method and resolves a JSON string. args is a JSON-serializable
// array; the callback is appended as the last argument.
function bridgeExpr(method, args) {
  const argsJson = JSON.stringify(args || []);
  return `new Promise(function(resolve){
    try {
      if (typeof PremiereBridge === 'undefined') {
        resolve(JSON.stringify({ok:false, error:'PremiereBridge not loaded (panel not ready)'})); return;
      }
      var __args = ${argsJson};
      __args.push(function(err, data){
        resolve(JSON.stringify({ok: !err, error: err ? String(err.message || err) : null, data: (data===undefined?null:data)}));
      });
      PremiereBridge[${JSON.stringify(method)}].apply(PremiereBridge, __args);
    } catch (e) { resolve(JSON.stringify({ok:false, error: String(e && e.message || e)})); }
  })`;
}

export async function callBridge(method, args, { timeoutMs } = {}) {
  const cfg = loadConfig();
  const raw = await evalInPanel(cfg.cdpPort, bridgeExpr(method, args), { timeoutMs: timeoutMs || 130000 });
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { throw new Error('Unparseable bridge response: ' + String(raw).slice(0, 300)); }
  if (!parsed.ok) throw new Error(`PremiereBridge.${method} failed: ${parsed.error}`);
  return parsed.data;
}
```

- [ ] **Step 2: Write `scripts/pr.mjs` with `snapshot` and `backup`**

```javascript
#!/usr/bin/env node
import { callBridge } from './lib/prbridge.mjs';

function out(obj) { console.log(JSON.stringify(obj, null, 2)); }

async function main() {
  const [cmd] = process.argv.slice(2);
  switch (cmd) {
    case 'snapshot': {
      const data = await callBridge('getTimelineSnapshot', []);
      out(data);
      break;
    }
    case 'backup': {
      const data = await callBridge('backupActiveSequence', []);
      out(data); // { ok, seqName, seqId }
      break;
    }
    default:
      console.error('Usage: pr.mjs <snapshot|backup|...>');
      process.exit(2);
  }
}
main().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
```

- [ ] **Step 3: Smoke test `snapshot` (read-only) against live panel**

Run: `node scripts/pr.mjs snapshot` (cwd = `Edit_Skill`, Premiere open with a sequence)
Expected: JSON with `clips`, `sequenceName`, `fps`. Confirms the bridge round-trip works.

- [ ] **Step 4: Smoke test `backup`**

Run: `node scripts/pr.mjs backup`
Expected: JSON `{ ok:true, seqName, seqId }` and a new `[backup HH:MM:SS]` sequence appears in Premiere's project panel.

- [ ] **Step 5: Note completion**

---

### Task 4: `pr.mjs transcribe` — read transcript cache

Reads the panel's transcript cache. Full transcription (Cloud.ru chunked Whisper) stays in the panel and is triggered by the user (MVP). This command returns the cached transcript for the active sequence, or a clear instruction if absent/stale.

**Files:**
- Modify: `Edit_Skill/scripts/pr.mjs` (add `transcribe` case + helper)
- Reads: `config.transcriptCachePath`

- [ ] **Step 1: Add a transcript-cache reader to `pr.mjs`**

Add near the top of `pr.mjs`, after the imports:

```javascript
import { readFileSync } from 'node:fs';
import { loadConfig } from './lib/config.mjs';

// The cache is a JSON object keyed by sequence name (see panel context-store.js).
// We look up the entry for the currently active sequence.
function readTranscriptForActiveSequence(sequenceName) {
  const cfg = loadConfig();
  let raw;
  try { raw = readFileSync(cfg.transcriptCachePath, 'utf8'); }
  catch { return { found: false, reason: 'no_cache_file' }; }
  let obj;
  try { obj = JSON.parse(raw); } catch { return { found: false, reason: 'corrupt_cache' }; }
  const entry = obj[sequenceName] || (obj.entries && obj.entries[sequenceName]);
  if (!entry) return { found: false, reason: 'no_entry_for_sequence', sequenceName };
  return { found: true, entry };
}
```

- [ ] **Step 2: Add the `transcribe` case to the `switch`**

```javascript
    case 'transcribe': {
      const snap = await callBridge('getTimelineSnapshot', []);
      const seqName = snap && snap.sequenceName;
      if (!seqName) { out({ ok: false, error: 'No active sequence' }); break; }
      const res = readTranscriptForActiveSequence(seqName);
      if (!res.found) {
        out({
          ok: false,
          needsTranscription: true,
          sequenceName: seqName,
          reason: res.reason,
          instruction: 'Open the "ИИ: монтаж" panel in Premiere and run transcription once for this sequence, then re-run pr.mjs transcribe.'
        });
        break;
      }
      out({ ok: true, sequenceName: seqName, transcript: res.entry });
      break;
    }
```

- [ ] **Step 3: Verify cache-shape assumption before relying on it**

Run: `node -e "const o=JSON.parse(require('fs').readFileSync('C:/Users/Глеб/.extensions_llm_chat_pr/_llm_transcript_cache.json','utf8')); console.log(Object.keys(o).slice(0,5))"`
Expected: prints top-level keys. Inspect whether keys are sequence names or nested under `entries`. If the shape differs from Step 1's lookup, adjust `readTranscriptForActiveSequence` to match the actual keys (this step exists specifically to confirm the shape on real data).

- [ ] **Step 4: Smoke test**

Run: `node scripts/pr.mjs transcribe` (with a sequence that has a cached transcript)
Expected: `{ ok:true, transcript: {...} }`. For a sequence without cache: `{ ok:false, needsTranscription:true, instruction: ... }`.

- [ ] **Step 5: Note completion**

---

### Task 5: `pr.mjs` mutating edits — `cut`, `markers`

**Files:**
- Modify: `Edit_Skill/scripts/pr.mjs`

Edit plans are passed as a JSON string argument (from a file to avoid shell-escaping issues). `cut` uses `applyTimecodeEdits` with `ripple_delete_interval` ops. `markers` uses `addSequenceMarkers`.

- [ ] **Step 1: Add a JSON-arg reader helper to `pr.mjs`**

```javascript
// Read a JSON payload either inline (--json '<...>') or from a file (--file path).
// File form is preferred for large plans.
function readPayloadArg(argv) {
  const fileIdx = argv.indexOf('--file');
  if (fileIdx !== -1) return JSON.parse(readFileSync(argv[fileIdx + 1], 'utf8'));
  const jsonIdx = argv.indexOf('--json');
  if (jsonIdx !== -1) return JSON.parse(argv[jsonIdx + 1]);
  throw new Error('Provide --file <path> or --json <string>');
}
```

- [ ] **Step 2: Add `cut` and `markers` cases**

```javascript
    case 'cut': {
      // payload: { ops: [ { type:"ripple_delete_interval", startSec, endSec }, ... ] }
      const plan = readPayloadArg(process.argv.slice(2));
      if (!plan || !Array.isArray(plan.ops)) throw new Error('cut payload needs { ops: [...] }');
      const data = await callBridge('applyTimecodeEdits', [plan], { timeoutMs: 130000 });
      out(data); // { ok, undoSteps, appliedCount }
      break;
    }
    case 'markers': {
      // payload: [ { startSec, name, comment, color }, ... ]
      const markers = readPayloadArg(process.argv.slice(2));
      if (!Array.isArray(markers)) throw new Error('markers payload must be an array');
      const data = await callBridge('addSequenceMarkers', [markers], { timeoutMs: 60000 });
      out(data); // { ok, count }
      break;
    }
```

- [ ] **Step 3: Create a tiny test plan file**

Create `Edit_Skill/scripts/_smoke_markers.json`:

```json
[{ "startSec": 1.0, "name": "SMOKE TEST", "comment": "delete me", "color": 1 }]
```

- [ ] **Step 4: Smoke test `markers` (reversible)**

Run: `node scripts/pr.mjs markers --file scripts/_smoke_markers.json` (backup first!)
Expected: `{ ok:true, count:1 }` and a marker at 1s in Premiere. Remove it manually or leave for cleanup. Do NOT smoke-test `cut` blindly — only run it against a backed-up throwaway sequence with a known interval.

- [ ] **Step 5: Note completion**

---

### Task 6: `pr.mjs` reels — `reframe-sources`, `reframe`, `overlay`, `activate`

**Files:**
- Modify: `Edit_Skill/scripts/pr.mjs`

Vertical reels reuse `getVerticalReframeSources` (read) + `applyVerticalReframe` (mutate). Overlays reuse `importAndOverlayOnTop`. Sequence switching reuses `activateSequenceByName` / `activateSequenceById`.

- [ ] **Step 1: Add reels cases to `pr.mjs`**

```javascript
    case 'reframe-sources': {
      const data = await callBridge('getVerticalReframeSources', []);
      out(data); // { ok, clips:[{nodeId,name,startSec},...] }
      break;
    }
    case 'reframe': {
      // payload: { clips: [ { nodeId, scalePercent, ... }, ... ] }
      const plan = readPayloadArg(process.argv.slice(2));
      const data = await callBridge('applyVerticalReframe', [plan], { timeoutMs: 130000 });
      out(data);
      break;
    }
    case 'overlay': {
      // payload: { filePath, startSec, ... }
      const payload = readPayloadArg(process.argv.slice(2));
      const data = await callBridge('importAndOverlayOnTop', [payload], { timeoutMs: 130000 });
      out(data);
      break;
    }
    case 'activate': {
      // --by-id <seqId>  OR  --by-name <name>
      const argv = process.argv.slice(2);
      const idIdx = argv.indexOf('--by-id');
      const nameIdx = argv.indexOf('--by-name');
      let data;
      if (idIdx !== -1) data = await callBridge('activateSequenceById', [argv[idIdx + 1]]);
      else if (nameIdx !== -1) data = await callBridge('activateSequenceByName', [{ name: argv[nameIdx + 1] }]);
      else throw new Error('activate needs --by-id <id> or --by-name <name>');
      out(data);
      break;
    }
    case 'import': {
      // payload: { filePath, binName? }
      const payload = readPayloadArg(process.argv.slice(2));
      const data = await callBridge('importMediaFile', [payload], { timeoutMs: 130000 });
      out(data);
      break;
    }
```

- [ ] **Step 2: Smoke test `reframe-sources` (read-only)**

Run: `node scripts/pr.mjs reframe-sources`
Expected: JSON list of video clips. Confirms read path; mutating reels ops are validated during e2e (Task 9) on a backed-up sequence.

- [ ] **Step 3: Note completion**

---

### Task 7: `gen.mjs` — Phygital generation client

**Files:**
- Create: `Edit_Skill/scripts/gen.mjs`

Reads the sidecar token, sends `X-Phygital-Sidecar-Token` on all non-`/health` calls, creates a job, polls, downloads the result to a local path. Supports `--dry-run` (preview cost only).

- [ ] **Step 1: Write `scripts/gen.mjs`**

```javascript
#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from './lib/config.mjs';

const cfg = loadConfig();

function token() {
  try { return readFileSync(cfg.sidecarTokenPath, 'utf8').trim(); }
  catch { return ''; }
}
function authHeaders() {
  const t = token();
  const h = { 'Content-Type': 'application/json' };
  if (t) h['X-Phygital-Sidecar-Token'] = t;
  return h;
}
async function sc(path, opts = {}) {
  const res = await fetch(cfg.sidecarBaseUrl + path, opts);
  if (res.status === 401) {
    throw new Error('Sidecar 401 — token missing/mismatched. Ensure sidecar was started via schtasks (real session) and recon is done.');
  }
  return res;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function createJob(nodeId, params, initFiles) {
  const body = { node_id: nodeId, params };
  if (initFiles) body.init_files = initFiles;
  const res = await sc('/jobs', { method: 'POST', headers: authHeaders(), body: JSON.stringify(body) });
  if (!res.ok) throw new Error('createJob failed: ' + res.status + ' ' + (await res.text()).slice(0, 300));
  return (await res.json()).job_id;
}
async function pollJob(jobId, { timeoutMs = 600000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await sc(`/jobs/${jobId}`, { headers: authHeaders() });
    const job = await res.json();
    if (['completed', 'failed', 'canceled'].includes(job.status)) return job;
    await sleep(2000);
  }
  throw new Error('pollJob timeout for ' + jobId);
}
async function downloadResult(jobId, outPath, index = 0) {
  const res = await sc(`/jobs/${jobId}/download?index=${index}`, { headers: authHeaders() });
  if (!res.ok) throw new Error('download failed: ' + res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  mkdirSync(join(outPath, '..'), { recursive: true });
  writeFileSync(outPath, buf);
  return outPath;
}
async function previewCost(nodeId, params) {
  const res = await sc('/jobs/preview-cost', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ node_id: nodeId, params }) });
  return res.json(); // { credits, currency }
}
function out(o) { console.log(JSON.stringify(o, null, 2)); }

function argVal(argv, flag) { const i = argv.indexOf(flag); return i !== -1 ? argv[i + 1] : undefined; }

async function main() {
  const argv = process.argv.slice(2);
  const [cmd] = argv;
  const dryRun = argv.includes('--dry-run');

  // node_id defaults: image=94, video Kling=74, video Seedance=100, voice=89, upscale=87
  const specs = {
    image:   { node: 94,  build: () => ({ prompt: argVal(argv, '--prompt') }) },
    video:   { node: Number(argVal(argv, '--node') || 74), build: () => ({ prompt: argVal(argv, '--prompt'), scenario: argVal(argv, '--scenario') || 't2v' }) },
    voice:   { node: 89,  build: () => ({ text: argVal(argv, '--text'), voice: argVal(argv, '--voice') || 'rv5jQF81clh7R2mBDAEQ' }) },
    upscale: { node: 87,  build: () => ({ output_upscale: argVal(argv, '--scale') || 'X2', output_container: 'mp4' }) },
  };
  if (cmd === 'health') { const r = await fetch(cfg.sidecarBaseUrl + '/health'); out(await r.json()); return; }
  const spec = specs[cmd];
  if (!spec) { console.error('Usage: gen.mjs <health|image|video|voice|upscale> [--prompt ..] [--out ..] [--dry-run]'); process.exit(2); }

  const params = spec.build();
  if (dryRun) { out({ dryRun: true, node: spec.node, params, cost: await previewCost(spec.node, params) }); return; }

  // init_files for upscale/video (e.g. --in <path>) passed through
  const inFile = argVal(argv, '--in');
  const initFiles = inFile ? (cmd === 'upscale' ? { init_video: inFile } : { init_img: [inFile] }) : undefined;

  const jobId = await createJob(spec.node, params, initFiles);
  const job = await pollJob(jobId);
  if (job.status !== 'completed') { out({ ok: false, status: job.status, error: job.error, jobId }); process.exit(1); }
  const outPath = argVal(argv, '--out') || join(process.cwd(), 'gen-out', `${jobId}`);
  const saved = await downloadResult(jobId, outPath);
  out({ ok: true, jobId, saved, resultPaths: job.result_paths });
}
main().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
```

- [ ] **Step 2: Smoke test `health` (no token needed)**

Run: `node scripts/gen.mjs health` (sidecar running)
Expected: `{ ok:true, jwt_ttl_sec: <n>, active_jobs: 0, ... }`. If connection refused → sidecar not up (Task 8 handles starting it).

- [ ] **Step 3: Smoke test `--dry-run` (auth + cost, no credits spent)**

Run: `node scripts/gen.mjs image --prompt "test" --dry-run`
Expected: `{ dryRun:true, cost:{ credits, currency } }`. A 401 here means the token path/sync is wrong — fix before real generation.

- [ ] **Step 4: Note completion** (do NOT run a real paid generation as a smoke test; that is validated during e2e with user confirmation)

---

### Task 8: `preflight.mjs` — verify/start panel + sidecar + auth

**Files:**
- Create: `Edit_Skill/scripts/preflight.mjs`

Checks the panel (CDP), checks the sidecar (`/health`), starts the sidecar via `schtasks` outside the MSIX container if down, and reports auth readiness.

- [ ] **Step 1: Write `scripts/preflight.mjs`**

```javascript
#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { evalInPanel } from './lib/cdp.mjs';
import { loadConfig } from './lib/config.mjs';

const cfg = loadConfig();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function checkPanel() {
  try {
    const title = await evalInPanel(cfg.cdpPort, 'typeof PremiereBridge', { timeoutMs: 8000 });
    return { ok: title === 'object' || title === 'function', detail: 'PremiereBridge typeof=' + title };
  } catch (e) { return { ok: false, detail: e.message }; }
}
async function checkSidecar() {
  try {
    const res = await fetch(cfg.sidecarBaseUrl + '/health');
    const h = await res.json();
    return { ok: !!h.ok, health: h };
  } catch (e) { return { ok: false, detail: e.message }; }
}

// Start sidecar OUTSIDE the MSIX container via Task Scheduler so it reads the
// real %LOCALAPPDATA%\PhygitalStudio (session.json/sidecar.token).
function startSidecarViaSchtasks() {
  const taskName = 'PhygitalSidecarAutopilot';
  const tr = `cmd /c cd /d "${cfg.sidecarAppDir}" && ${cfg.pythonExe} -m app.main`;
  // /create with /f overwrites; /sc ONCE + far date; then /run immediately.
  execFileSync('schtasks', ['/create', '/tn', taskName, '/tr', tr, '/sc', 'ONCE', '/st', '00:00', '/f'], { stdio: 'pipe' });
  execFileSync('schtasks', ['/run', '/tn', taskName], { stdio: 'pipe' });
  return taskName;
}

async function main() {
  const panel = await checkPanel();
  let sidecar = await checkSidecar();

  if (!sidecar.ok) {
    try {
      const task = startSidecarViaSchtasks();
      for (let i = 0; i < 20 && !sidecar.ok; i++) { await sleep(1000); sidecar = await checkSidecar(); }
      sidecar.startedVia = task;
    } catch (e) { sidecar.startError = 'schtasks failed: ' + e.message; }
  }

  const authReady = sidecar.ok && sidecar.health && typeof sidecar.health.jwt_ttl_sec === 'number' && sidecar.health.jwt_ttl_sec > 0;

  const report = {
    panel: panel.ok ? 'ready' : 'MISSING — open Premiere and the "ИИ: монтаж" panel',
    panelDetail: panel.detail,
    sidecar: sidecar.ok ? 'ready' : 'DOWN — could not reach /health',
    sidecarDetail: sidecar.detail || sidecar.startError,
    auth: authReady ? 'ready' : 'NOT AUTHED — run: python -m scripts.cli auth login (in a normal terminal)',
    ready: panel.ok && sidecar.ok && authReady,
  };
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.ready ? 0 : 1);
}
main().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
```

- [ ] **Step 2: Run preflight with everything down**

Run: `node scripts/preflight.mjs` (Premiere closed, sidecar down)
Expected: report with `panel: MISSING`, and it attempts schtasks for the sidecar. `ready:false`, exit code 1.

- [ ] **Step 3: Run preflight with Premiere + panel open and after recon**

Run: `node scripts/preflight.mjs`
Expected: `{ panel:'ready', sidecar:'ready', auth:'ready', ready:true }`, exit 0. Verify the sidecar it started is reachable and authed (i.e., schtasks desandbox worked). If `auth` is `NOT AUTHED` despite recon, the schtasks-launched sidecar is reading the wrong path — investigate before proceeding.

- [ ] **Step 4: Note completion**

---

### Task 9: `SKILL.md` — orchestration workflow

**Files:**
- Create: `Edit_Skill/SKILL.md`

- [ ] **Step 1: Write `SKILL.md`**

````markdown
---
name: premiere-autopilot
description: Use when the user wants to montage a podcast/interview in a live Adobe Premiere Pro — cut a highlight edit, make vertical reels, add chapters, and generate/insert AI b-roll/voice. Drives the live Premiere via the LLM-Chat_Pr panel and generates assets via the Phygital sidecar.
---

# premiere-autopilot

Drive a **live** Adobe Premiere Pro to produce a turnkey montage. Claude makes the
editorial decisions; the skill's CLI helpers execute them against the running app.

## Prerequisites (the user handles these once)
- Premiere open with the **"ИИ: монтаж"** panel (LLM-Chat_Pr) — gives CDP port 8098.
- Phygital login done once via recon: `python -m scripts.cli auth login`.

## Approval model (B — semi-auto)
- One backup at the start; then run the pipeline autonomously.
- **Only stop for confirmation before paid generations** (`gen.mjs` image/video/voice/upscale).
- Roll back anytime via `pr.mjs activate --by-id <backup seqId>`.

## Workflow (podcast/interview → highlight edit + reels)

1. **Preflight** — `node scripts/preflight.mjs`. Do not proceed unless `ready:true`.
   If panel MISSING → ask the user to open it. If auth NOT AUTHED → ask the user to run recon.
2. **Backup** — `node scripts/pr.mjs backup`. Record `seqId` for rollback.
3. **Snapshot** — `node scripts/pr.mjs snapshot`. Understand clips/fps/duration.
4. **Transcript** — `node scripts/pr.mjs transcribe`. If `needsTranscription:true`,
   ask the user to run transcription once in the panel, then retry.
5. **Decide highlights (Claude)** — read the transcript; choose the segments that make
   a ~5 min horizontal cut. Build a `cut` plan of `ripple_delete_interval` ops for the
   REMOVED ranges. Write it to a temp JSON file and apply: `node scripts/pr.mjs cut --file <plan.json>`.
6. **Chapters (Claude)** — derive 5–10 chapter points from the transcript. Write a
   markers array and apply: `node scripts/pr.mjs markers --file <markers.json>`.
7. **Reels (Claude)** — pick 3–5 punchy 30–60s moments. For each: duplicate/activate a
   vertical sequence, cut to the moment, then `pr.mjs reframe-sources` + build and apply
   a `reframe` plan (`node scripts/pr.mjs reframe --file <plan.json>`).
8. **Generative inserts (STOP — confirm, costs credits)** — for b-roll/covers/voiceover:
   preview cost first (`gen.mjs <kind> ... --dry-run`), confirm with the user, then generate
   (`gen.mjs image|video|voice --out <path>`), and insert
   (`pr.mjs import --file <p>` or `pr.mjs overlay --file <p>`). If a generation fails,
   report it and continue without that asset.
9. **Report** — summarize: highlight duration, chapters added, reels created, assets inserted,
   and the backup `seqId` for rollback.

## Payload shapes
- `cut` plan: `{ "ops": [ { "type":"ripple_delete_interval", "startSec":N, "endSec":N }, ... ] }`
- `markers`: `[ { "startSec":N, "name":"...", "comment":"...", "color":1 }, ... ]`
- `reframe` plan: `{ "clips": [ { "nodeId":"...", "scalePercent":N }, ... ] }` (get nodeIds from `reframe-sources`)
- `overlay`/`import`: `{ "filePath":"C:/.../asset.mp4", "startSec":N }`

## Safety
- Never run `cut` without a backup taken in step 2.
- Validate cut intervals against the snapshot duration before applying (no interval past end; no overlaps).
- Never smoke-test paid generations; always `--dry-run` + user confirmation first.
- Do not edit the two source repos.

## E2E checklist (real podcast project)
- [ ] preflight ready:true
- [ ] backup created, seqId recorded
- [ ] transcript loaded (or user triggered it)
- [ ] highlight cut applied, duration ≈ target
- [ ] chapters visible on timeline
- [ ] 3–5 vertical reels produced
- [ ] at least one generated asset inserted (after confirmation)
- [ ] rollback verified: activate backup seqId restores original
````

- [ ] **Step 2: Validate the frontmatter and file resolve**

Run: `node -e "const s=require('fs').readFileSync('SKILL.md','utf8'); console.log(s.startsWith('---') && s.includes('name: premiere-autopilot'))"` (cwd = `Edit_Skill`)
Expected: prints `true`.

- [ ] **Step 3: Note completion**

---

## Self-Review Notes

- **Spec coverage:** preflight+MSIX/schtasks (Task 8), pr bridge/snapshot/backup (Task 3), transcribe (Task 4), cut/markers (Task 5), reels/reframe/overlay/import (Task 6), gen image/video/voice/upscale + dry-run + token auth (Task 7), SKILL orchestration + approval model B + e2e checklist (Task 9). All spec sections map to a task.
- **Method-name consistency:** `pr.mjs` command names match `SKILL.md` (`snapshot`, `backup`, `transcribe`, `cut`, `markers`, `reframe-sources`, `reframe`, `overlay`, `import`, `activate`); bridge method names match `bridge-premiere.js`.
- **Open verification points flagged inline:** transcript cache shape (Task 4 Step 3) and schtasks-desandbox auth (Task 8 Step 3) are confirmed against real data/services during implementation rather than assumed.
- **No paid side effects in smoke tests:** generation is only exercised via `--dry-run` until the e2e run.
