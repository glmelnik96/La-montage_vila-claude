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
