import { readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const directory = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const targets = { arm64: 'aarch64-apple-darwin', x64: 'x86_64-apple-darwin', universal: 'universal-apple-darwin' };
let arch = process.arch;
let debug = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--debug') debug = true;
  else if (args[i] === '--arch') arch = args[++i];
  else throw new Error(`Unknown packaging option: ${args[i]}`);
}
if (process.platform !== 'darwin') throw new Error('macOS .app packaging requires macOS.');
if (!Object.hasOwn(targets, arch)) throw new Error('Use --arch arm64, x64, or universal.');

const config = JSON.parse(await readFile(join(directory, 'src-tauri/tauri.conf.json'), 'utf8'));
const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
if (config.version !== manifest.version || !/^\d+\.\d+\.\d+(?:-[\da-zA-Z.-]+)?(?:\+[\da-zA-Z.-]+)?$/.test(config.version)) {
  throw new Error('Package and Tauri versions must match and use a valid filename-safe version.');
}
function run(command, options, capture = false) {
  const result = spawnSync(command, options, { cwd: directory, stdio: capture ? 'pipe' : 'inherit', encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (capture && result.stderr) process.stderr.write(result.stderr);
    throw new Error(`${command} failed (${result.status ?? result.signal}).`);
  }
  return result.stdout?.trim();
}
// Use the native build cache when possible; cross/universal builds select an explicit Rust target.
const explicitTarget = arch !== process.arch || Boolean(process.env.CARGO_BUILD_TARGET);
const buildArgs = ['exec', 'tauri', 'build', '--bundles', 'app'];
if (debug) buildArgs.push('--debug');
if (explicitTarget) buildArgs.push('--target', targets[arch]);
run('pnpm', buildArgs);
const metadata = JSON.parse(run('cargo', ['metadata', '--no-deps', '--format-version', '1', '--manifest-path', 'src-tauri/Cargo.toml'], true));
const output = join(metadata.target_directory, ...(explicitTarget ? [targets[arch]] : []), debug ? 'debug' : 'release', 'bundle', 'macos');
const source = join(output, `${config.productName}.app`);
const executable = run('/usr/bin/plutil', ['-extract', 'CFBundleExecutable', 'raw', '-o', '-', join(source, 'Contents/Info.plist')], true);
const actual = run('/usr/bin/lipo', ['-archs', join(source, 'Contents/MacOS', executable)], true).split(/\s+/).sort();
const expected = arch === 'universal' ? ['arm64', 'x86_64'] : [arch === 'x64' ? 'x86_64' : 'arm64'];
if (actual.join(',') !== expected.join(',')) throw new Error(`Expected ${arch}, got ${actual.join(',')}.`);
// Rename only the outer bundle; retain its branded plist, executable and signature.
const destination = join(output, `popular-link-agent-${config.version}-${arch}.app`);
await rm(destination, { recursive: true, force: true });
await rename(source, destination);
const verification = spawnSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', destination], { encoding: 'utf8' });
if (verification.error) throw verification.error;
if (verification.status !== 0 && debug) {
  const signature = spawnSync('/usr/bin/codesign', ['-dv', destination], { encoding: 'utf8' });
  if (signature.error) throw signature.error;
  // Rust debug binaries may only have a linker signature, without a sealed app bundle.
  if (!/Signature=adhoc|code object is not signed/.test(signature.stderr ?? '')) {
    throw new Error('Bundle signature is invalid; refusing to replace a non-ad-hoc identity.');
  }
  run('/usr/bin/codesign', ['--force', '--sign', '-', destination]);
}
run('/usr/bin/codesign', ['--verify', '--deep', '--strict', destination]);
process.stdout.write(`Packaged: ${destination}\n`);
