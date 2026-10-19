import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DocsDocument, DocsEntry } from '@movie-hub/contract';
import { AppError } from '../../infrastructure/http/app-error.js';
import { aiStep } from '../../infrastructure/logging/ai-trace.js';

const MAX_DOCUMENT_BYTES = 1024 * 1024;
const titleFor = (markdown: string, path: string) => {
  return (
    /^# +(.+?)\s*#*\s*$/m.exec(markdown)?.[1]?.trim() ||
    path.split('/').at(-1)!.replace(/\.md$/i, '').replace(/[-_]/g, ' ')
  );
};

/** Discover Markdown from disk on each request; never expose arbitrary filesystem paths. */
export class DocsService {
  constructor(
    private readonly root = fileURLToPath(new URL('../../../../../docs/', import.meta.url))
  ) {}

  private async readInside(root: string, path: string): Promise<string> {
    const canonical = await realpath(resolve(root, path));
    const local = relative(root, canonical);
    if (!local || local.startsWith(`..${sep}`) || local === '..' || resolve(root, local) !== canonical)
      throw new AppError(404, 'NOT_FOUND', 'Document not found');
    const info = await stat(canonical);
    if (!info.isFile()) throw new AppError(404, 'NOT_FOUND', 'Document not found');
    if (info.size > MAX_DOCUMENT_BYTES) throw new AppError(413, 'BAD_REQUEST', 'Document exceeds the 1 MB limit');
    return readFile(canonical, 'utf8');
  }

  async list(): Promise<DocsEntry[]> {
    return aiStep('docs.directory.scan', async () => {
      let root: string;
      try {
        root = await realpath(this.root);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
      }
      const items: DocsEntry[] = [];
      const visit = async (directory: string) => {
        const entries = await readdir(directory, { withFileTypes: true });
        for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
          if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
          const absolute = resolve(directory, entry.name);
          if (entry.isDirectory()) await visit(absolute);
          else if (entry.isFile() && /\.md$/i.test(entry.name)) {
            const path = relative(root, absolute).split(sep).join('/');
            const markdown = await this.readInside(root, path);
            items.push({ path, title: titleFor(markdown, path) });
          }
        }
      };
      await visit(root);
      return items;
    });
  }

  async read(path: string): Promise<DocsDocument> {
    const entries = await this.list();
    const entry = entries.find((item) => item.path === path);
    if (!entry) throw new AppError(404, 'NOT_FOUND', 'Document not found');
    return aiStep('docs.document.read', async () => {
      try {
        return { ...entry, markdown: await this.readInside(await realpath(this.root), path) };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT')
          throw new AppError(404, 'NOT_FOUND', 'Document not found');
        throw error;
      }
    });
  }
}
