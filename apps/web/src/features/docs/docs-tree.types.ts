import type { DocsEntry } from '@movie-hub/contract';

export interface DocsNode {
  name: string;
  path: string;
  document?: DocsEntry;
  children: DocsNode[];
}
