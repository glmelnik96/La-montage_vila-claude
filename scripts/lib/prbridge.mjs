import { evalInPanel } from './cdp.mjs';
import { loadConfig } from './config.mjs';

// Build a JS expression (run in the panel) that calls a callback-style PremiereBridge method
// and resolves a JSON string. args is a JSON-serializable array. Every method takes its callback
// last, except evalJson(expr, callback, opts), whose opts carry `mutating` and the panel's own
// timeout: appending the callback after them would make opts the callback.
function bridgeExpr(method, args, opts) {
  const argsJson = JSON.stringify(args || []);
  const optsJson = JSON.stringify(opts || null);
  return `new Promise(function(resolve){
    try {
      if (typeof PremiereBridge === 'undefined') {
        resolve(JSON.stringify({ok:false, error:'PremiereBridge not loaded (panel not ready)'})); return;
      }
      var __args = ${argsJson}, __opts = ${optsJson};
      var __cb = function(err, data){
        resolve(JSON.stringify({ok: !err, error: err ? String(err.message || err) : null, data: (data===undefined?null:data)}));
      };
      if (__opts) __args = [__args[0], __cb, __opts]; else __args.push(__cb);
      PremiereBridge[${JSON.stringify(method)}].apply(PremiereBridge, __args);
    } catch (e) { resolve(JSON.stringify({ok:false, error: String(e && e.message || e)})); }
  })`;
}

// evalJson runs as a MUTATING call unless { mutating: false } is passed. Then the panel never
// re-runs a script that answered 'EvalScript error.', 'undefined' or '' — its cold-start retry
// would apply a half-finished edit two or three times — and it waits `timeoutMs` (default
// 120 s) instead of a fixed 30 s. On a timeout the edit keeps running inside Premiere: poll a
// cheap read until the host answers, never re-issue. Other methods keep the panel's own options
// (the mutating ones already run with 120 s); `timeoutMs` is then only the socket's limit.
export async function callBridge(method, args, { timeoutMs, mutating = true } = {}) {
  const cfg = loadConfig();
  const isEval = method === 'evalJson';
  const limit = timeoutMs || (isEval ? 120000 : 130000);
  const opts = isEval ? { mutating, timeoutMs: limit } : null;
  const raw = await evalInPanel(cfg.cdpPort, bridgeExpr(method, args, opts), { timeoutMs: isEval ? limit + 10000 : limit });
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { throw new Error('Unparseable bridge response: ' + String(raw).slice(0, 300)); }
  if (!parsed.ok) throw new Error(`PremiereBridge.${method} failed: ${parsed.error}`);
  return parsed.data;
}
