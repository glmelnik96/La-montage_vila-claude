#!/usr/bin/env node
// Open a Premiere project with nobody at the keyboard (references/after-effects-link.md, «Getting
// Premiere to a project with no clicks from the user», says why each step is done this way).
//   node scripts/propen.mjs --project <existing .prproj> [--timeout 240]
// Panel up (some project open): app.openDocument with every dialog suppressed. Otherwise launch
// Premiere if needed, press the Home screen's "Open Project" (UIA by name, else the measured offset),
// fill the Win32 file dialog by WM_SETTEXT + IDOK, and wait for the panel. A project path on the
// command line does NOT work on 26.3. Nothing is clicked while Premiere shows any window besides its
// main one (a splash, a dialog): the script waits, and on timeout stops with a capture of every window.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { callBridge } from './lib/prbridge.mjs';
import { getPageTarget } from './lib/cdp.mjs';
import { loadConfig } from './lib/config.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : d; };
const PROJECT = arg('project') && resolve(arg('project'));
const TIMEOUT = Number(arg('timeout', 240)) * 1000;
if (!PROJECT || !existsSync(PROJECT)) { console.error('usage: propen.mjs --project <existing .prproj> [--timeout 240]'); process.exit(2); }
const cfg = loadConfig();
const EXE = `${cfg.premiereDir || 'C:/Program Files/Adobe/Adobe Premiere Pro 2026'}/Adobe Premiere Pro.exe`;
const PROC = 'Adobe Premiere Pro*';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fwd = (p) => p.replace(/\\/g, '/');
const ps = (script, args) => execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(HERE, 'win', script), ...args], { encoding: 'utf8' }).trim();

async function panelUp() { try { await getPageTarget(cfg.cdpPort); return true; } catch { return false; } }
function hasWindow() {
  const n = execFileSync('powershell.exe', ['-NoProfile', '-Command', `@(Get-Process | Where-Object { $_.ProcessName -like "${PROC}" -and $_.MainWindowHandle -ne 0 }).Count`], { encoding: 'utf8' }).trim();
  return Number(n) > 0;
}
const windows = () => { try { return JSON.parse(ps('wincap.ps1', ['-Proc', PROC, '-List']) || '[]'); } catch { return []; } };
// 26.3 draws the Home screen as its own untitled window over the empty main one. Its class is the
// generic "DroverLord - Window Class" that dialogs have too, so tell it by covering the main window.
const isHome = (w, main) => !w.main && !w.title && !!main && w.w >= 0.9 * main.w && w.h >= 0.8 * main.h;
// anything but the main window, the Home screen, Premiere's overlays and the file dialog we opened
const others = (ws) => {
  const main = ws.find((w) => w.main);
  return ws.filter((w) => !w.main && !isHome(w, main) && !/Overlay Window/i.test(w.title) && w.title !== 'Open Project');
};
const describe = (ws) => ws.map((w) => `'${w.title}' ${w.w}x${w.h}`).join(', ');
function stop(msg) {
  const dir = join(tmpdir(), 'propen_' + Date.now());
  mkdirSync(dir, { recursive: true });
  let caps = '';
  try { caps = ps('wincap.ps1', ['-Proc', PROC, '-OutDir', dir]); } catch { /* no windows */ }
  console.log(JSON.stringify({ ok: false, error: msg, windows: caps.split(/\r?\n/).filter(Boolean) }, null, 2));
  process.exit(1);
}
const openJsx = (doOpen) => `(function () {
    var want = new File(${JSON.stringify(fwd(PROJECT))}).fsName;
    if (${doOpen ? 'true' : 'false'} && String(app.project.path).toLowerCase() !== want.toLowerCase()) { app.openDocument(want, true, true, true); }
    var open = [];
    for (var i = 0; i < app.projects.numProjects; i++) { open.push(String(app.projects[i].path)); }
    return JSON.stringify({ focused: String(app.project.path), wanted: want, open: open });
  })()`;
const parse = (r) => (typeof r === 'string' ? JSON.parse(r) : r);
// Opening is a mutating call (the panel then never re-runs it, and waits the whole timeout). A big
// project can outlast the bridge: the open keeps running, so poll a read — never call it again.
async function openInPanel() {
  try { return parse(await callBridge('evalJson', [openJsx(true)], { timeoutMs: 180000 })); } catch (e) {
    if (!/timeout|не ответил/i.test(String(e.message))) throw e;
    for (let i = 0; i < 60; i++) {
      await sleep(3000);
      try { return parse(await callBridge('evalJson', [openJsx(false)], { mutating: false, timeoutMs: 10000 })); } catch { /* still opening */ }
    }
    throw e;
  }
}

let via = 'panel';
if (!(await panelUp())) {
  if (!hasWindow()) { spawn(EXE, [], { detached: true, stdio: 'ignore' }).unref(); via = 'launched'; }
  const t0 = Date.now();
  let clicked = null, seen = '', lastClick = '';
  while (!clicked) {
    if (Date.now() - t0 > TIMEOUT) stop(`no Home screen to click within ${TIMEOUT / 1000} s` + (seen ? `; other windows up: ${seen}` : '') + (lastClick ? `; last click: ${lastClick}` : ''));
    await sleep(3000);
    if (await panelUp()) break;                       // a project came up by itself
    const ws = windows(), main = ws.find((w) => w.main), extra = others(ws);
    if (extra.length) { seen = describe(extra); continue; }   // a splash or a dialog: never click past it
    if (!main) continue;
    if (/\.prproj/i.test(main.title)) stop(`a project is open (${main.title}) but the panel is not on port ${cfg.cdpPort}: open the «ИИ: монтаж» panel`);
    if (!ws.some((w) => isHome(w, main))) continue;           // the Home screen is not drawn yet
    try {
      const r = JSON.parse(ps('uiclick.ps1', ['-Proc', PROC, '-Name', 'Open Project', '-RelX', '83', '-RelY', '238', '-MainTitle', 'Adobe Premiere']));
      if (r.ok) clicked = r;
    } catch (e) { lastClick = String(e.stdout || e.message).trim(); }   // not drawn yet, or covered: retried
  }
  if (clicked) {
    via = `${via === 'launched' ? 'launched, ' : ''}Home screen (${clicked.how})`;
    let filled = false;
    for (let i = 0; i < 20 && !filled; i++) {
      await sleep(1000);
      try { filled = /posted IDOK/.test(ps('filedlg.ps1', ['-Title', 'Open Project', '-Path', PROJECT])); } catch { /* not open yet */ }
    }
    if (!filled) stop(`clicked "Open Project" (${clicked.how}) but no file dialog came up`);
  }
  const t1 = Date.now();
  while (!(await panelUp())) {
    if (Date.now() - t1 > TIMEOUT) stop(`the panel did not come up on port ${cfg.cdpPort}` + (others(windows()).length ? `; other windows up: ${describe(others(windows()))}` : ''));
    await sleep(3000);
  }
}
const r = await openInPanel();
const ok = r.focused.toLowerCase() === r.wanted.toLowerCase();
console.log(JSON.stringify({ ok, via, ...r, warning: r.open.length > 1 ? 'several projects are open: ask the user to close the others (SKILL.md, before touching anything)' : undefined }, null, 2));
process.exitCode = ok ? 0 : 1;
