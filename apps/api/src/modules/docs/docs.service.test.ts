import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DocsService } from './docs.service.js';

test('scans nested Markdown dynamically, uses headings, and excludes hidden files, non-Markdown and symlinks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'popular-docs-'));
  try {
    await mkdir(join(root, 'guide'));
    await writeFile(join(root, 'guide', 'first.md'), '# First guide\n\nBody');
    await writeFile(join(root, 'fallback-name.MD'), 'No heading here');
    await writeFile(join(root, '.private.md'), '# Hidden');
    await writeFile(join(root, 'config.txt'), 'secret');
    await symlink(join(root, 'guide', 'first.md'), join(root, 'linked.md'));
    const service = new DocsService(root);
    assert.deepEqual(await service.list(), [
      { path: 'fallback-name.MD', title: 'fallback name' },
      { path: 'guide/first.md', title: 'First guide' },
    ]
    );
    assert.equal((await service.read('guide/first.md')).markdown, '# First guide\n\nBody');
    await writeFile(join(root, 'new.md'), '# Newly added');
    assert.ok((await service.list()).some((entry) => entry.path === 'new.md'));
    await rm(join(root, 'new.md'));
    assert.ok(!(await service.list()).some((entry) => entry.path === 'new.md'));
    for (const path of [
      '../config.txt',
      '/etc/passwd',
      'guide/../../config.txt',
      'linked.md',
      '.private.md',
      'config.txt',
    ]) {
      await assert.rejects(service.read(path), /Document not found/);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a symlink directory cannot expose documents outside the scanned root', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'popular-docs-boundary-'));
  try {
    await mkdir(join(parent, 'docs'));
    await mkdir(join(parent, 'outside'));
    await writeFile(join(parent, 'outside', 'secret.md'), '# Private document');
    await symlink(join(parent, 'outside'), join(parent, 'docs', 'escape'));
    const service = new DocsService(join(parent, 'docs'));
    assert.deepEqual(await service.list(), []);
    await assert.rejects(service.read('escape/secret.md'), /Document not found/);
    assert.deepEqual(await new DocsService(join(parent, 'missing')).list(), []);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
