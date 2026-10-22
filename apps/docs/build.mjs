import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, extname } from 'node:path';

const root = fileURLToPath(new URL('../../', import.meta.url));
const source = resolve(root, '.archify');
const output = resolve(root, 'apps/docs/dist');
const assetExtensions = new Set(['.html', '.json', '.css', '.js', '.svg', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.woff', '.woff2', '.webm', '.mp4', '.pdf']);
const projects = [];
const escape = (value) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

// Publish presentation assets only. Source snapshots, symlinks and hidden files stay private.
async function copyAssets(from, to) {
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'evidence' || entry.isSymbolicLink()) continue;
    const input = resolve(from, entry.name);
    const target = resolve(to, entry.name);
    if (entry.isDirectory()) await copyAssets(input, target);
    else if (entry.isFile() && assetExtensions.has(extname(entry.name))) await cp(input, target);
  }
}

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
let entries = [];
try {
  entries = await readdir(source, { withFileTypes: true });
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
for (const entry of entries.sort((a, b) => b.name.localeCompare(a.name))) {
  if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith('.')) continue;
  const directory = resolve(source, entry.name);
  const files = await readdir(directory, { withFileTypes: true });
  if (!files.some((file) => file.name === 'index.html' && file.isFile())) continue;
  await copyAssets(directory, resolve(output, 'archify', entry.name));
  projects.push(`<a class="project" href="archify/${encodeURIComponent(entry.name)}/index.html"><span>${escape(entry.name)}</span><span aria-hidden="true">↗</span></a>`);
}
const template = await readFile(new URL('./index.html', import.meta.url), 'utf8');
await writeFile(resolve(output, 'index.html'), template.replace('<!-- PROJECTS -->', projects.join('\n')));
await cp(new URL('./docs.messages.js', import.meta.url), resolve(output, 'docs.messages.js'));
console.info(`Built ${projects.length} archify project(s) in apps/docs/dist`);
