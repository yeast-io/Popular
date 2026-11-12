// The website favicon and SVG status compositions are authoritative. Generate assets only; never build or package the application.
import { mkdtemp, copyFile, readFile, writeFile, rm } from 'node:fs/promises';
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
const website = join(root, '../../web/public/favicon.svg');
const mark = (await readFile(website, 'utf8')).replace(/\s*<rect[^>]*\/>/, '');
const tray = join(temporary, 'tray.svg');
const offline = join(temporary, 'tray-offline.svg');
// Template images must have a transparent background; opaque colored tiles render as solid squares on macOS.
await writeFile(tray, mark);
await writeFile(offline, mark.replace('</svg>', '<path d="M10 10L54 54" fill="none" stroke="#111111" stroke-width="5" stroke-linecap="round"/></svg>'));
const jobs = [
  [website, null, [
    ['icon.png', 'app/src-tauri/icons/icon.png'], ['icon.icns', 'app/src-tauri/icons/icon.icns'],
    ['icon.ico', 'app/src-tauri/icons/icon.ico'], ['128x128.png', 'ui/src/assets/popular-link-agent-white-ui.png'],
  ]],
  [website, ['128', '512'], [
    ['512x512.png', 'app/src-tauri/icons/icon-dark.png'], ['128x128.png', 'ui/src/assets/popular-link-agent-black-ui.png'],
  ]],
  [tray, ['32'], [['32x32.png', 'app/src-tauri/icons/tray.png']]],
  [offline, ['32'], [['32x32.png', 'app/src-tauri/icons/tray-offline.png']]],
  [join(root, 'ui/src/assets/connection-online.svg'), ['36'], [['36x36.png', 'app/src-tauri/icons/connection-online.png']]],
  [join(root, 'ui/src/assets/connection-offline.svg'), ['36'], [['36x36.png', 'app/src-tauri/icons/connection-offline.png']]],
];
try {
  for (const [index, [source, size, files]] of jobs.entries()) {
    const output = join(temporary, `job-${index}`);
    // Each CLI process owns its logger; repeated in-process invocations reinitialize it.
    await execute(process.execPath, [cli, 'icon', source, '--output', output, ...(size ? size.flatMap((value) => ['--png', value]) : [])]);
    for (const [generated, destination] of files) {
      await copyFile(join(output, generated), join(root, destination));
    }
    process.stdout.write(`Generated ${source}\n`);
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}
