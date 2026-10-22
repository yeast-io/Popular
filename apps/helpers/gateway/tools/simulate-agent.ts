// Workspace-only test harness; the deployed Gateway has no API implementation dependency.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = new URL('../../../../', import.meta.url);
const result = spawnSync(
  process.execPath,
  [
    '--import',
    fileURLToPath(new URL('apps/api/node_modules/tsx/dist/loader.mjs', root)),
    fileURLToPath(new URL('tools/remote-gateway/simulate.mjs', root)),
  ],
  { stdio: 'inherit' }
);
process.exitCode = result.status ?? 1;
