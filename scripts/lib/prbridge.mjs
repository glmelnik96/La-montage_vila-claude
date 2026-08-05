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
