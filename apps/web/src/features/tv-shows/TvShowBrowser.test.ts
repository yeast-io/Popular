// @vitest-environment happy-dom
import { mount, flushPromises } from '@vue/test-utils';
import { afterEach, expect, it, vi } from 'vitest';
import TvShowBrowser from './TvShowBrowser.vue';
import { setLocale } from '../../i18n';

const wrappers: ReturnType<typeof mount>[] = [];
afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount());
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it('TV browser retains generation, deduplicates cards, changes language and opens a TV show', async () => {
  setLocale('en-US');
  const urls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    const next = url.includes('page=2');
    return Response.json({ items: (next ? [42, 43] : [42]).map((id) => ({ mediaType: 'tv', tmdbId: id, name: `Series ${id}` })),
      page: next ? 2 : 1, hasMore: !next, generation: '00000000-0000-4000-8000-000000000001', stale: false });
  }));
  const wrapper = mount(TvShowBrowser);
  wrappers.push(wrapper);
  await flushPromises();
  await wrapper.get('.tv-load-more button').trigger('click');
  await flushPromises();
  expect(urls[1]).toContain('generation=00000000-0000-4000-8000-000000000001');
  expect(wrapper.findAll('.tv-show-card')).toHaveLength(2);
  await wrapper.get('.tv-show-card').trigger('click');
  expect(wrapper.emitted('openTvShow')).toEqual([[42]]);
  setLocale('zh-CN');
  await flushPromises();
  expect(urls.at(-1)).toContain('locale=zh-CN');
  expect(urls.at(-1)).not.toContain('generation=');
  expect(wrapper.findAll('.tv-show-card')).toHaveLength(1);
  expect(wrapper.get('input[type="search"]').attributes('placeholder')).toBe('搜索电视剧…');
});
it('failed initial load can retry and stale cached lists are explicitly labeled', async () => {
  setLocale('en-US');
  let fail = true;
  vi.stubGlobal('fetch', vi.fn(async () => fail ? new Response('{}', { status: 503 }) : Response.json({ items: [], page: 1, hasMore: false, generation: 'a', stale: true })));
  const wrapper = mount(TvShowBrowser);
  wrappers.push(wrapper);
  await flushPromises();
  expect(wrapper.find('[role="alert"]').exists()).toBe(true);
  fail = false;
  await wrapper.get('[role="alert"] button').trigger('click');
  await flushPromises();
  expect(wrapper.find('[role="alert"]').exists()).toBe(false);
  expect(wrapper.text()).toContain('Showing cached information');
});

it('debounces TV searches, paginates without a trending generation, retains locale and restores trending when cleared', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  setLocale('en-US');
  const urls: URL[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost');
    urls.push(url);
    const search = url.pathname.endsWith('/search');
    const page = Number(url.searchParams.get('page'));
    return Response.json({ items: [{ mediaType: 'tv', tmdbId: search ? 100 + page : 42, name: search ? `Search ${page}` : 'Trending item' }],
      page, hasMore: search && page === 1, ...(search ? {} : { generation: '00000000-0000-4000-8000-000000000001' }), stale: false });
  }));
  const wrapper = mount(TvShowBrowser);
  wrappers.push(wrapper);
  await flushPromises();
  expect(wrapper.find('h2').exists()).toBe(false);
  expect(wrapper.text()).not.toContain('Refresh');
  await wrapper.get('.floating-search-toggle').trigger('click');
  const input = wrapper.get('input[type="search"]');
  expect(input.attributes('placeholder')).toBe('Search TV shows…');
  await input.setValue('The');
  await vi.advanceTimersByTimeAsync(100);
  await input.setValue('  The Bear  ');
  await vi.advanceTimersByTimeAsync(299);
  expect(urls).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1);
  await flushPromises();
  expect(urls.at(-1)?.pathname).toContain('/tv-shows/search');
  expect(urls.at(-1)?.searchParams.get('query')).toBe('The Bear');
  expect(urls.at(-1)?.searchParams.has('generation')).toBe(false);
  expect(wrapper.text()).toContain('Search 1');
  await wrapper.get('.tv-load-more button').trigger('click');
  await flushPromises();
  expect(urls.at(-1)?.searchParams.get('page')).toBe('2');
  expect(wrapper.findAll('.tv-show-card')).toHaveLength(2);
  setLocale('zh-CN');
  await flushPromises();
  expect(urls.at(-1)?.searchParams.get('locale')).toBe('zh-CN');
  expect(urls.at(-1)?.searchParams.get('query')).toBe('The Bear');
  expect(urls.at(-1)?.searchParams.get('page')).toBe('1');
  await input.setValue('');
  await vi.advanceTimersByTimeAsync(300);
  await flushPromises();
  expect(urls.at(-1)?.pathname).toContain('/tv-shows/trending');
  expect(urls.at(-1)?.searchParams.has('query')).toBe(false);
  expect(wrapper.text()).toContain('Trending item');
});

it('ignores late results from an old TV search even when the transport ignores cancellation', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  setLocale('en-US');
  const pending = new Map<string, (response: Response) => void>();
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost');
    const term = url.searchParams.get('query');
    return term
      ? new Promise<Response>((resolve) => pending.set(term, resolve))
      : Promise.resolve(Response.json({ items: [], page: 1, hasMore: false, generation: 'g' }));
  }));
  const wrapper = mount(TvShowBrowser);
  wrappers.push(wrapper);
  await flushPromises();
  await wrapper.get('.floating-search-toggle').trigger('click');
  const input = wrapper.get('input[type="search"]');
  await input.setValue('Old');
  await vi.advanceTimersByTimeAsync(300);
  await input.setValue('Current');
  await vi.advanceTimersByTimeAsync(300);
  pending.get('Current')!(Response.json({ items: [{ mediaType: 'tv', tmdbId: 100, name: 'Current result' }], page: 1, hasMore: false, stale: false }));
  await flushPromises();
  pending.get('Old')!(Response.json({ items: [{ mediaType: 'tv', tmdbId: 101, name: 'Old result' }], page: 1, hasMore: false, stale: false }));
  await flushPromises();
  expect(wrapper.text()).toContain('Current result');
  expect(wrapper.text()).not.toContain('Old result');
});

it('shows a dedicated search empty state in Chinese', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  setLocale('zh-CN');
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ items: [], page: 1, hasMore: false, stale: false })));
  const wrapper = mount(TvShowBrowser);
  wrappers.push(wrapper);
  await flushPromises();
  await wrapper.get('.floating-search-toggle').trigger('click');
  await wrapper.get('input[type="search"]').setValue('不存在的电视剧');
  await vi.advanceTimersByTimeAsync(300);
  await flushPromises();
  expect(wrapper.text()).toContain('没有找到匹配的电视剧。');
});

it.each(['en-US', 'zh-CN'] as const)('saves, restores and clears mutually exclusive TV preferences without opening details (%s)', async (locale) => {
  setLocale(locale);
  const writes: { method: string; body: string | undefined }[] = [];
  let saved = 'liked';
  let failed = false;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
    if (String(input).includes('/preference?')) {
      writes.push({ method: options?.method ?? 'GET', body: options?.body as string | undefined });
      if (failed) return new Response('{}', { status: 503 });
      saved = options?.method === 'DELETE' ? 'neutral' : JSON.parse(String(options?.body)).preference;
      return Response.json({ tmdbId: 42, preference: saved });
    }
    return Response.json({ items: [{ mediaType: 'tv', tmdbId: 42, name: 'Series', userPreference: saved }], page: 1, hasMore: false, generation: 'a', stale: false });
  }));
  let wrapper = mount(TvShowBrowser, { props: { authenticated: true } });
  wrappers.push(wrapper);
  await flushPromises();
  expect(wrapper.get('.preference-button').attributes('aria-pressed')).toBe('true');
  expect(wrapper.get('.preference-button').attributes('aria-label')).toBe(locale === 'zh-CN' ? '取消喜欢' : 'Remove liked');
  await wrapper.get('.preference-button.dislike').trigger('click');
  await flushPromises();
  expect(wrapper.get('.preference-button').attributes('aria-pressed')).toBe('false');
  expect(wrapper.get('.preference-button.dislike').attributes('aria-pressed')).toBe('true');
  expect(wrapper.emitted('openTvShow')).toBeUndefined();
  wrapper.unmount();
  wrappers.pop();
  wrapper = mount(TvShowBrowser, { props: { authenticated: true } });
  wrappers.push(wrapper);
  await flushPromises();
  expect(wrapper.get('.preference-button.dislike').attributes('aria-pressed')).toBe('true');
  failed = true;
  await wrapper.get('.preference-button').trigger('click');
  await flushPromises();
  expect(wrapper.get('.preference-button.dislike').attributes('aria-pressed')).toBe('true');
  expect(wrapper.get('[role="alert"]').text()).toContain(locale === 'zh-CN' ? '电视剧喜好保存失败' : 'Unable to save your TV preference');
  failed = false;
  await wrapper.get('.preference-button.dislike').trigger('click');
  await flushPromises();
  expect(wrapper.find('.preference-button.active').exists()).toBe(false);
  expect(writes.map((write) => write.method)).toEqual(['PUT', 'PUT', 'DELETE']);
  expect(writes[0]?.body).toBe('{"preference":"disliked"}');
});
it.each(['en-US', 'zh-CN'] as const)('hides preferences for guests and disables both controls while a save is pending (%s)', async (locale) => {
  setLocale(locale);
  let finish!: (response: Response) => void;
  let writes = 0;
  vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, options?: RequestInit) => {
    if (options?.method) {
      ++writes;
      return new Promise<Response>((resolve) => {
        finish = resolve;
      });
    }
    return Response.json({ items: [{ mediaType: 'tv', tmdbId: 42, name: 'Series' }], page: 1, hasMore: false });
  }));
  const wrapper = mount(TvShowBrowser);
  wrappers.push(wrapper);
  await flushPromises();
  expect(wrapper.find('.tv-show-card').exists()).toBe(true);
  expect(wrapper.find('.preference-control').exists()).toBe(false);
  expect(writes).toBe(0);
  await wrapper.setProps({ authenticated: true });
  await wrapper.get('.preference-button').trigger('click');
  expect(wrapper.findAll('.preference-button').every((button) => button.attributes('disabled') !== undefined)).toBe(true);
  expect(writes).toBe(1);
  setLocale('zh-CN');
  await flushPromises();
  expect(wrapper.get('.preference-button').attributes('aria-pressed')).toBe('true');
  finish(Response.json({ tmdbId: 42, preference: 'liked' }));
  await flushPromises();
  expect(wrapper.get('.preference-button').attributes('disabled')).toBeUndefined();
  await wrapper.setProps({ authenticated: false });
  expect(wrapper.findAll('.preference-button')).toHaveLength(0);
});
