// Run an arbitrary ExtendScript expression (from a file) in the live panel host.
// Usage: node scripts/_ev.mjs <path-to-jsx-file>
import { callBridge } from './lib/prbridge.mjs';
import { readFileSync } from 'fs';

const file = process.argv[2];
if (!file) { console.error('usage: node scripts/_ev.mjs <jsx-file>'); process.exit(2); }
const expr = readFileSync(file, 'utf8');
const data = await callBridge('evalJson', [expr], { timeoutMs: 120000 });
console.log(typeof data === 'string' ? data : JSON.stringify(data, null, 2));
