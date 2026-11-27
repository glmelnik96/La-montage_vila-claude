// Save the focused Premiere project, keep a copy, close it, run a command on the closed .prproj, and open it again.
// For edits only the project file can take (time remapping keyframes: scripts/prprojremap.py). Ask the user first:
// their project closes for the length of the command.
//   node scripts/prreopen.mjs --expect <path part> --copy "<copy.prproj>" -- <command> [args ...]
// The command gets the project's path as its last argument; a failing command puts the copy back.
// The editing panel closes with the project (2026-10-28: the close call itself dropped the bridge), so the close is
// fired and the bridge is not waited on, and the project is opened again through its file association: the running
// Premiere takes it (a second process starts, hands the file over and exits). Then the panel is awaited.
import { copyFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { callBridge } from './lib/prbridge.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const EXPECT = arg('expect'), COPY = arg('copy'), cmd = process.argv.slice(process.argv.indexOf('--') + 1);
if (!EXPECT || !COPY || process.argv.indexOf('--') < 0 || !cmd.length) { console.error('usage: prreopen.mjs --expect <part> --copy <file> -- <cmd ...>'); process.exit(2); }
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = async (b, o = {}) => { const r = await callBridge('evalJson', [`(function(){try{ ${b} }catch(e){return JSON.stringify({error:String(e),line:e.line});}})()`], { timeoutMs: 60000, ...o });
  return typeof r === 'string' ? JSON.parse(r) : r; };
const st = await ev(`if(app.projects.numProjects!==1) return JSON.stringify({error:app.projects.numProjects+' projects open'});
  var p=app.project; if(String(p.path).indexOf(${JSON.stringify(EXPECT)})<0) return JSON.stringify({error:'focused project is '+p.path});
  var ok=p.save(); return JSON.stringify({path:String(p.path), saved:String(ok)});`);
if (st.error) { console.error(st); process.exit(1); }
const path = st.path.replace(/\\/g, '/');
copyFileSync(path, COPY);
console.log(`saved ${path}; copy ${COPY} (${statSync(COPY).size} bytes)`);
await ev(`app.project.closeDocument(false, false); return JSON.stringify({closed:true});`).catch((e) => console.log('close: the bridge went with the panel, as expected'));
let open = 1;
for (let i = 0; i < 30 && open; i++) {
  await pause(1000);
  open = await ev(`return JSON.stringify({n:app.projects.numProjects});`, { mutating: false }).then((r) => r.n).catch(() => 0);
}
if (open) { console.error('the project did not close: nothing changed'); process.exit(1); }
const r = spawnSync(cmd[0], [...cmd.slice(1), path], { stdio: 'inherit' });
if (r.status !== 0) { copyFileSync(COPY, path); console.error(`command failed (${r.status}): the project file is back to the copy`); }
spawnSync('powershell', ['-NoProfile', '-Command', `Start-Process -FilePath '${path.replace(/'/g, "''")}'`], { stdio: 'inherit' });
let ok = null;
for (let i = 0; i < 60 && !ok; i++) {
  await pause(3000);
  ok = await ev(`return JSON.stringify({path:app.project?String(app.project.path):null});`, { mutating: false }).then((x) => x.path).catch(() => null);
}
console.log(ok ? `reopened ${ok}` : 'the panel did not come back: open the project in Premiere');
process.exit(r.status === 0 && ok ? 0 : 1);
