import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(here, '..', '..', 'config.json');
const DEFAULT_CONFIG_PATH = join(here, '..', '..', 'config.example.json');

export function loadConfig() {
  let configText;
  try {
    configText = readFileSync(CONFIG_PATH, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    configText = readFileSync(DEFAULT_CONFIG_PATH, 'utf8');
  }
  const cfg = JSON.parse(configText);
  if (!cfg.cdpPort || !cfg.sidecarBaseUrl) {
    throw new Error('config.json missing cdpPort or sidecarBaseUrl');
  }
  return cfg;
}
