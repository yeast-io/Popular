// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { renderMarkdown } from './markdown';
import { buildDocsTree } from './docs-tree';

it('renders Markdown tables, code fences, stable anchors and relative document links', () => {
  const result = renderMarkdown('# Hello World\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n```ts\nconst a = 1;\n```\n\n[Guide](../guide.md#start)', 'nested/first.md');
  expect(result).toContain('id="hello-world"');
  expect(result).toContain('<table>');
  expect(result).toContain('language-ts');
  expect(result).toContain('/docs?path=guide.md#start');
  expect(result).toContain('data-doc-path="guide.md"');
});

it('removes executable HTML and unsafe URLs while retaining Mermaid source for rendering', () => {
  const result = renderMarkdown('<script>alert(1)</script><img src="x" onerror="alert(1)"><a href="javascript:alert(1)">bad</a>\n\n```mermaid\nflowchart TD\nA-->B\n```', 'a.md');
  expect(result).not.toContain('<script');
  expect(result).not.toContain('onerror');
  expect(result).not.toContain('javascript:');
  expect(result).toContain('language-mermaid');
});

it('builds sidebars from discovered paths without fixed filenames', () => {
  const nodes = buildDocsTree([{ path: 'new/folder/topic.md', title: 'Topic' }, { path: 'other.md', title: 'Other' }]);
  expect(nodes[0]?.children[0]?.children[0]?.document?.title).toBe('Topic');
  expect(nodes[1]?.document?.path).toBe('other.md');
});
