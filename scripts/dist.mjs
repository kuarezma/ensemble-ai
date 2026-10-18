import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
// Downloaded builder icon tools are CommonJS; isolate them from this ESM package.
mkdirSync('.electron-builder-cache', { recursive: true });
writeFileSync('.electron-builder-cache/package.json', JSON.stringify({ type: 'commonjs' }));
// Keep builder downloads inside the checkout; do not infer a developer HOME.
const env = {
  ...process.env,
  ELECTRON_BUILDER_CACHE: path.resolve('.electron-builder-cache'),
  electron_config_cache: path.resolve('.electron-cache'),
};
const result = spawnSync(
  process.execPath,
  ['node_modules/electron-builder/out/cli/cli.js', ...process.argv.slice(2)],
  { stdio: 'inherit', env },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
