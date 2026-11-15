import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import { lightingPlugin } from './scripts/lighting-plugin';

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig(({ command, mode }) => {
  let build = loadEnv(mode, root, 'VITE_GAMEANALYTICS_BUILD').VITE_GAMEANALYTICS_BUILD;
  if (!build && command === 'build') {
    try { build = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
    catch { build = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version; }
  }
  return { base: './', plugins: [lightingPlugin()],
    define: { 'import.meta.env.VITE_GAMEANALYTICS_BUILD': JSON.stringify(build || 'local') } };
});
