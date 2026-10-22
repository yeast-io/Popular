import { spawnSync } from 'node:child_process';

const result = spawnSync('cargo', ['test', '--offline', '--manifest-path', 'src-tauri/Cargo.toml', 'connection::tests::gateway_', '--', '--ignored'], {
  cwd: new URL('..', import.meta.url),
  env: { ...process.env, HELPER_ALLOW_INSECURE_DEV: 'true', LOG_LEVEL: 'off' },
  stdio: 'inherit',
});
process.exit(result.status ?? 1);
