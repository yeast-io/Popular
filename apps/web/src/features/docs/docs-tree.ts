import type { DocsNode } from './docs-tree.types.js';
import type { DocsEntry } from '@movie-hub/contract';

export function buildDocsTree(entries: DocsEntry[]): DocsNode[] {
  const root: DocsNode[] = [];
  for (const entry of entries) {
    let siblings = root;
    const parts = entry.path.split('/');
    for (const [index, part] of parts.entries()) {
      const path = parts.slice(0, index + 1).join('/');
      let node = siblings.find((item) => item.path === path);
      if (!node) {
        node = { name: part, path, children: [] };
        siblings.push(node);
      }
      if (index === parts.length - 1) node.document = entry;
      siblings = node.children;
    }
  }
  return root;
}
