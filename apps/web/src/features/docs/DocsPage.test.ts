// @vitest-environment jsdom
import { mount, flushPromises } from '@vue/test-utils';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import DocsPage from './DocsPage.vue';

beforeEach(() => { vi.stubGlobal('matchMedia', () => ({ matches: false })); });
afterEach(() => { vi.unstubAllGlobals(); window.history.replaceState({}, '', '/'); });
it('loads the scanned navigation and selected Markdown, and supports document navigation', async () => {
  window.history.replaceState({}, '', '/docs');
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/docs')) return Response.json({ items: [{ path: 'a.md', title: 'Alpha' }, { path: 'folder/b.md', title: 'Beta' }] });
    const path = new URL(url, 'http://localhost').searchParams.get('path');
    return Response.json({ path, title: path, markdown: path === 'a.md' ? '# Alpha\n\n[Next](folder/b.md)' : '# Beta\n\nSecond document' });
  }));
  const wrapper = mount(DocsPage);
  try {
    await flushPromises();
    expect(wrapper.get('.docs-markdown').text()).toContain('Alpha');
    await wrapper.get('.docs-tree a, .docs-markdown a').trigger('click'); await flushPromises();
    expect(wrapper.get('.docs-markdown').text()).toContain('Second document');
    expect(new URLSearchParams(window.location.search).get('path')).toBe('folder/b.md');
    expect(wrapper.get('[aria-current="page"]').text()).toBe('Beta');
  } finally { wrapper.unmount(); }
});

it('handles empty scanned directories and failed document loads', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ items: [] })));
  const empty = mount(DocsPage); await flushPromises();
  expect(empty.find('.docs-markdown').exists()).toBe(false);
  expect(empty.find('[role="alert"]').exists()).toBe(false); empty.unmount();
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })));
  const failed = mount(DocsPage); await flushPromises();
  expect(failed.find('[role="alert"]').exists()).toBe(true); failed.unmount();
});
