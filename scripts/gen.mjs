#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from 'node:fs';
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
  let res;
  try {
    res = await fetch(cfg.sidecarBaseUrl + path, opts);
  } catch (e) {
    throw new Error(`Sidecar unreachable at ${cfg.sidecarBaseUrl}${path} — is it running? Run: node scripts/preflight.mjs (${e.message})`);
  }
  if (res.status === 401) {
    throw new Error('Sidecar 401 — token missing/mismatched. Restart the sidecar so it reloads sidecar.token, then retry.');
  }
  return res;
}

// Turn a non-ok sidecar response into a clear error instead of letting a caller
// blindly res.json() an HTML/error body (which yields cryptic "Unexpected token
// 'I'" from "Internal Server Error"). A 5xx on an authed call is almost always
// an expired Phygital session, so we point the caller at recon.
async function ensureOk(res, label) {
  if (res.ok) return res;
  const body = (await res.text()).slice(0, 300);
  if (res.status >= 500) {
    throw new Error(`${label} ${res.status} — likely an expired Phygital session. Re-run recon: python -m scripts.cli auth login. Body: ${body}`);
  }
  throw new Error(`${label} failed: ${res.status} ${body}`);
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
    await ensureOk(res, `poll job ${jobId}`);
    const job = await res.json();
    if (['completed', 'failed', 'canceled'].includes(job.status)) return job;
    await sleep(2000);
  }
  throw new Error('pollJob timeout for ' + jobId);
}
async function downloadResult(job, outPath, index = 0) {
  const jobId = job.job_id;
  mkdirSync(join(outPath, '..'), { recursive: true });
  // Preferred path: HTTP /download. But the sidecar's download guard
  // canonicalizes result paths against its own downloads_dir and can 403
  // ("path_outside_downloads") when the resolved junction root differs from the
  // stored path (Windows AppData redirection). The job already reports the real
  // on-disk result_paths, and we run on the same machine with real filesystem
  // access, so fall back to copying that file directly.
  try {
    const res = await sc(`/jobs/${jobId}/download?index=${index}`, { headers: authHeaders() });
    if (res.ok) {
      writeFileSync(outPath, Buffer.from(await res.arrayBuffer()));
      return { outPath, via: 'http' };
    }
    if (res.status !== 403) throw new Error('download failed: ' + res.status);
  } catch (e) {
    if (!/download failed: 403|path_outside_downloads/.test(e.message) && !(e instanceof TypeError)) {
      // Non-403 network/HTTP failure and not the guard case — surface it unless
      // we can still recover from the local path below.
    }
  }
  const local = Array.isArray(job.result_paths) ? job.result_paths[index] : undefined;
  if (local && existsSync(local)) {
    copyFileSync(local, outPath);
    return { outPath, via: 'local_copy', source: local };
  }
  throw new Error(`download failed (HTTP 403 and no readable local result_paths[${index}]=${local || 'none'})`);
}
async function previewCost(nodeId, params) {
  const res = await sc('/jobs/preview-cost', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ node_id: nodeId, params }) });
  await ensureOk(res, 'preview-cost');
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
  if (cmd === 'fetch') {   // collect a job whose run was interrupted: gen.mjs fetch --job <id> [--out <path>]
    const jobId = argVal(argv, '--job');
    if (!jobId) { console.error('Usage: gen.mjs fetch --job <jobId> [--out <path>]'); process.exit(2); }
    const job = await pollJob(jobId);
    if (job.status !== 'completed') { out({ ok: false, status: job.status, error: job.error, jobId }); process.exit(1); }
    const saved = await downloadResult(job, argVal(argv, '--out') || join(process.cwd(), 'gen-out', `${jobId}`));
    out({ ok: true, jobId, saved, resultPaths: job.result_paths });
    return;
  }
  const spec = specs[cmd];
  if (!spec) { console.error('Usage: gen.mjs <health|image|video|voice|upscale|fetch> [--prompt ..] [--out ..] [--dry-run] [--job <id>]'); process.exit(2); }

  const params = spec.build();
  if (dryRun) { out({ dryRun: true, node: spec.node, params, cost: await previewCost(spec.node, params) }); return; }

  // init_files for upscale/video (e.g. --in <path>) passed through
  const inFile = argVal(argv, '--in');
  const initFiles = inFile ? (cmd === 'upscale' ? { init_video: inFile } : { init_img: [inFile] }) : undefined;

  const jobId = await createJob(spec.node, params, initFiles);
  // printed at once: if this run is killed, the paid job still finishes — collect it with `fetch`
  console.error(`job ${jobId} created (paid). If this run is interrupted: node scripts/gen.mjs fetch --job ${jobId} --out <path>`);
  const job = await pollJob(jobId);
  if (job.status !== 'completed') { out({ ok: false, status: job.status, error: job.error, jobId }); process.exit(1); }
  const outPath = argVal(argv, '--out') || join(process.cwd(), 'gen-out', `${jobId}`);
  const saved = await downloadResult(job, outPath);
  out({ ok: true, jobId, saved, resultPaths: job.result_paths });
}
main().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
