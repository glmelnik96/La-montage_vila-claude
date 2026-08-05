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
    // Settle only after the socket has fully closed. Resolving/rejecting while the
    // WebSocket handle is still mid-close races libuv teardown and can trip a
    // UV_HANDLE_CLOSING assertion when the process exits immediately after (e.g.
    // preflight's process.exit). We stash the outcome and deliver it in onclose.
    let settled = false;
    let pendingErr = null;
    let pendingValue;
    const deliver = () => { if (pendingErr) reject(pendingErr); else resolve(pendingValue); };
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      pendingErr = err;
      pendingValue = value;
      clearTimeout(timer);
      try { ws.close(); } catch { deliver(); }
    };
    const timer = setTimeout(() => finish(new Error(`CDP timeout ${timeoutMs}ms`)), timeoutMs);
    ws.onclose = () => { clearTimeout(timer); deliver(); };
    ws.onerror = (e) => finish(new Error('WS error: ' + (e.message || e)));
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
      if (data.error) { finish(new Error('CDP: ' + JSON.stringify(data.error))); return; }
      const r = data.result || {};
      if (r.exceptionDetails) {
        const ex = r.exceptionDetails;
        finish(new Error('Panel exception: ' + (ex.exception?.description || ex.text)));
        return;
      }
      finish(null, r.result?.value);
    };
  });
}

export async function evalInPanel(port, expression, opts) {
  const page = await getPageTarget(port);
  return cdpEval(page.webSocketDebuggerUrl, expression, opts);
}
