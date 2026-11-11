// Selected robot PNGs and SVG status compositions are authoritative. Generate assets only; never build or package the application.
import { mkdtemp, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';

const root = fileURLToPath(new URL('..', import.meta.url));
const cli = createRequire(new URL('../app/package.json', import.meta.url)).resolve('@tauri-apps/cli/tauri.js');
const execute = promisify(execFile);
const temporary = await mkdtemp(join(tmpdir(), 'popular-link-icons-'));
const jobs = [
  ['popular-link-agent-white.png', null, [
    ['icon.png', 'app/src-tauri/icons/icon.png'], ['icon.icns', 'app/src-tauri/icons/icon.icns'],
    ['icon.ico', 'app/src-tauri/icons/icon.ico'], ['128x128.png', 'ui/src/assets/popular-link-agent-white-ui.png'],
  ]],
  ['popular-link-agent-black.png', ['128', '512'], [
    ['512x512.png', 'app/src-tauri/icons/icon-dark.png'], ['128x128.png', 'ui/src/assets/popular-link-agent-black-ui.png'],
  ]],
  ['popular-link-agent-mark.png', ['32'], [['32x32.png', 'app/src-tauri/icons/tray.png']]],
  ['popular-link-offline.svg', ['32'], [['32x32.png', 'app/src-tauri/icons/tray-offline.png']]],
  ['connection-online.svg', ['36'], [['36x36.png', 'app/src-tauri/icons/connection-online.png']]],
  ['connection-offline.svg', ['36'], [['36x36.png', 'app/src-tauri/icons/connection-offline.png']]],
];
try {
  for (const [source, size, files] of jobs) {
    const output = join(temporary, source);
    // Each CLI process owns its logger; repeated in-process invocations reinitialize it.
    await execute(process.execPath, [cli, 'icon', join(root, 'ui/src/assets', source), '--output', output, ...(size ? size.flatMap((value) => ['--png', value]) : [])]);
    for (const [generated, destination] of files) {
      await copyFile(join(output, generated), join(root, destination));
    }
    process.stdout.write(`Generated ${source}\n`);
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}
