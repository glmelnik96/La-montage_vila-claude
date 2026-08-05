#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
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

// Probe the sidecar-token wall (everything except /health requires the
// X-Phygital-Sidecar-Token). /health being green does NOT prove the token
// matches — a stale in-memory token in a lingering sidecar returns 401 on the
// real endpoints. This catches exactly the failure gen.mjs would hit.
async function checkAuthWall() {
  let token = '';
  try { token = readFileSync(cfg.sidecarTokenPath, 'utf8').trim(); }
  catch (e) { return { ok: false, detail: 'sidecar.token unreadable: ' + e.message }; }
  try {
    const res = await fetch(cfg.sidecarBaseUrl + '/nodes', { headers: { 'X-Phygital-Sidecar-Token': token } });
    if (res.status === 401) return { ok: false, detail: 'token wall 401 — sidecar.token mismatch (restart sidecar to reload token)' };
    return { ok: res.ok, detail: 'GET /nodes -> ' + res.status };
  } catch (e) { return { ok: false, detail: e.message }; }
}

// Start the sidecar as a detached background process from its own venv. This
// host (Bash/node) sees the real %LOCALAPPDATA%, so the sidecar reads the real
// session.json/sidecar.token directly — no Task Scheduler indirection needed.
function startSidecar() {
  const child = spawn(cfg.pythonExe, ['-m', 'app.main'], {
    cwd: cfg.sidecarAppDir,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  return child.pid;
}

async function main() {
  const panel = await checkPanel();
  let sidecar = await checkSidecar();

  if (!sidecar.ok) {
    try {
      const pid = startSidecar();
      for (let i = 0; i < 20 && !sidecar.ok; i++) { await sleep(1000); sidecar = await checkSidecar(); }
      sidecar.startedPid = pid;
    } catch (e) { sidecar.startError = 'spawn failed: ' + e.message; }
  }

  const sessionReady = sidecar.ok && sidecar.health && typeof sidecar.health.jwt_ttl_sec === 'number' && sidecar.health.jwt_ttl_sec > 0;
  const authWall = sidecar.ok ? await checkAuthWall() : { ok: false, detail: 'sidecar down' };
  const authReady = sessionReady && authWall.ok;

  let authMsg;
  if (authReady) authMsg = 'ready';
  else if (!sessionReady) authMsg = 'NO SESSION — Phygital session expired. Re-run recon: python -m scripts.cli auth login';
  else authMsg = 'TOKEN WALL — ' + authWall.detail;

  const report = {
    panel: panel.ok ? 'ready' : 'MISSING — open Premiere and the "ИИ: монтаж" panel',
    panelDetail: panel.detail,
    sidecar: sidecar.ok ? 'ready' : 'DOWN — could not reach /health',
    sidecarDetail: sidecar.detail || sidecar.startError,
    auth: authMsg,
    authWallDetail: authWall.detail,
    ready: panel.ok && sidecar.ok && authReady,
  };
  console.log(JSON.stringify(report, null, 2));
  // Set exitCode and let Node drain the loop naturally. Calling process.exit()
  // here force-closes undici/WebSocket handles mid-teardown and trips a libuv
  // UV_HANDLE_CLOSING assertion on Windows (exit 127 despite a good report).
  process.exitCode = report.ready ? 0 : 1;
}
main().catch((e) => { console.error('ERROR:', e.message); process.exitCode = 1; });
