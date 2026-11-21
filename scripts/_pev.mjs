// Evaluate arbitrary JS in the live CEP panel context (NOT host JSX).
// Usage: node scripts/_pev.mjs <path-to-js-file>
import { evalInPanel } from './lib/cdp.mjs';
import { loadConfig } from './lib/config.mjs';
import { readFileSync } from 'fs';

const file = process.argv[2];
if (!file) { console.error('usage: node scripts/_pev.mjs <js-file>'); process.exit(2); }
const expr = readFileSync(file, 'utf8');
const cfg = loadConfig();
const data = await evalInPanel(cfg.cdpPort, expr, { timeoutMs: 60000 });
console.log(typeof data === 'string' ? data : JSON.stringify(data, null, 2));
