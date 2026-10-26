// @vitest-environment happy-dom
import { defineComponent, KeepAlive } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setLocale } from '../../i18n';
import WatchlistPage from './WatchlistPage.vue';

function response(mediaType = 'movie', page = 1) {
  return { items: [{ mediaType, tmdbId: page, title: `${mediaType} ${page}`, overview: 'Overview', releaseDate: '2020-01-01', voteAverage: 8.1, posterUrl: 'https://example.com/poster.jpg' }], pagination: { page, pageSize: 20, total: mediaType === 'tv' ? 3 : 21, hasMore: page === 1 }, locale: 'en-US' };
}
function host() {
  return mount(defineComponent({ components: { WatchlistPage, KeepAlive }, template: '<KeepAlive><WatchlistPage /></KeepAlive>' }));
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe('Watch list', () => {
  it('renders rows with independent actions, switches media categories, paginates and opens correct details', async () => {
    setLocale('en-US');
    const fetch = vi.fn(async (input: string, _options?: RequestInit) => {
      const url = new URL(input, 'http://localhost');
      return Response.json(response(url.searchParams.get('mediaType')!, Number(url.searchParams.get('page'))));
    });
    vi.stubGlobal('fetch', fetch);
    const wrapper = host();
    await flushPromises();
    const page = wrapper.getComponent(WatchlistPage);
    expect(page.find('.watchlist-heading').exists()).toBe(false);
    expect(page.findAll('.watchlist-count').map((badge) => badge.text())).toEqual(['21', '3']);
    expect(page.get('.watchlist-entry').text()).toContain('Overview');
    expect(page.find('.watchlist-entry button').exists()).toBe(false);
    expect(page.find('.status-control').exists()).toBe(false);
    await page.get('.watchlist-entry').trigger('click');
    expect(page.emitted('openMovie')).toEqual([[1]]);
    await page.get('.tv-load-more button').trigger('click');
    await flushPromises();
    expect(page.findAll('.watchlist-entry')).toHaveLength(2);
    await page.get('.watchlist-filters button:nth-child(2)').trigger('click');
    await flushPromises();
    expect(page.findAll('.watchlist-entry')).toHaveLength(1);
    expect(page.text()).toContain('tv 1');
    await page.get('.watchlist-entry').trigger('click');
    expect(page.emitted('openTvShow')).toEqual([[1]]);
    expect(fetch.mock.calls.every(([, options]) => (options as RequestInit | undefined)?.credentials === 'include')).toBe(true);
    wrapper.unmount();
  });
  it('ignores late responses from the previous category', async () => {
    setLocale('zh-CN');
    let resolveMovie!: (value: Response) => void;
    vi.stubGlobal('fetch', vi.fn((input: string) => input.includes('mediaType=movie')
      ? new Promise<Response>((resolve) => {
          resolveMovie = resolve;
        })
      : Promise.resolve(Response.json(response('tv')))));
    const wrapper = host();
    await wrapper.get('.watchlist-filters button:nth-child(2)').trigger('click');
    await flushPromises();
    resolveMovie(Response.json(response('movie')));
    await flushPromises();
    expect(wrapper.get('section').attributes('aria-label')).toBe('想看清单');
    expect(wrapper.text()).toContain('tv 1');
    expect(wrapper.text()).not.toContain('movie 1');
    wrapper.unmount();
  });
  it('shows localized empty and failure states with retry', async () => {
    setLocale('zh-CN');
    const fetch = vi.fn().mockRejectedValueOnce(new Error('offline')).mockImplementation(async () => Response.json({ ...response(), items: [], pagination: { page: 1, pageSize: 20, total: 0, hasMore: false } }));
    vi.stubGlobal('fetch', fetch);
    const wrapper = host();
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toContain('想看清单加载失败');
    await wrapper.get('[role="alert"] button').trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('电影想看清单为空');
    wrapper.unmount();
  });
});

it('retains every loaded page when reactivated after opening details', async () => {
  setLocale('en-US');
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    const url = new URL(input, 'http://localhost');
    return Response.json(response('movie', Number(url.searchParams.get('page'))));
  }));
  const wrapper = mount(defineComponent({ components: { WatchlistPage, KeepAlive }, data: () => ({ visible: true }), template: '<KeepAlive><WatchlistPage v-if="visible" /></KeepAlive>' }));
  await flushPromises();
  await wrapper.get('.tv-load-more button').trigger('click');
  await flushPromises();
  expect(wrapper.findAll('.watchlist-entry')).toHaveLength(2);
  await wrapper.setData({ visible: false });
  await wrapper.setData({ visible: true });
  await flushPromises();
  expect(wrapper.findAll('.watchlist-entry')).toHaveLength(2);
  expect(wrapper.text()).toContain('movie 1');
  expect(wrapper.text()).toContain('movie 2');
  wrapper.unmount();
});

it.each(['en-US', 'zh-CN'] as const)('removes movies and TV shows using the in-card button without opening details (%s)', async (locale) => {
  setLocale(locale);
  const removed = new Set<string>();
  const fetcher = vi.fn(async (input: string, _options?: RequestInit) => {
    const url = new URL(input, 'http://localhost');
    const match = url.pathname.match(/watchlist\/(movie|tv)\/1/);
    if (match) {
      const media = match[1]!;
      removed.add(media);
      return Response.json({ inWatchlist: false });
    }
    const media = url.searchParams.get('mediaType')!;
    const result = response(media);
    return Response.json({ ...result, items: removed.has(media) ? [] : result.items, pagination: { page: 1, pageSize: 20, total: removed.has(media) ? 0 : 1, hasMore: false } });
  });
  vi.stubGlobal('fetch', fetcher);
  const wrapper = host();
  await flushPromises();
  const page = wrapper.getComponent(WatchlistPage);
  expect(wrapper.find('[role="switch"]').exists()).toBe(false);
  expect(wrapper.get('.watchlist-row .watchlist-remove').attributes('title')).toBe(locale === 'zh-CN' ? '移出想看清单' : 'Remove from watch list');
  for (const media of ['movie', 'tv']) {
    if (media === 'tv') {
      await wrapper.get('.watchlist-filters button:nth-child(2)').trigger('click');
      await flushPromises();
    }
    vi.useFakeTimers();
    await wrapper.get('.watchlist-remove').trigger('click');
    await flushPromises();
    const requestsBeforeAnimation = fetcher.mock.calls.length;
    expect(wrapper.get('.watchlist-count').text()).toBe('0');
    await vi.advanceTimersByTimeAsync(150);
    expect(fetcher.mock.calls.length).toBe(requestsBeforeAnimation);
    await vi.advanceTimersByTimeAsync(150);
    await flushPromises();
    vi.useRealTimers();
    expect(wrapper.findAll('.watchlist-entry')).toHaveLength(0);
  }
  expect(page.emitted('openMovie')).toBeUndefined();
  expect(page.emitted('openTvShow')).toBeUndefined();
  expect(fetcher.mock.calls.every(([, options]) => options?.credentials === 'include')).toBe(true);
  wrapper.unmount();
});

it('disables removal while pending and allows retry after failure', async () => {
  setLocale('zh-CN');
  let rejectSave!: (cause: Error) => void;
  const fetcher = vi.fn((input: string, options?: RequestInit) => options?.method === 'DELETE'
    ? new Promise<Response>((_resolve, reject) => { rejectSave = reject; })
    : Promise.resolve(Response.json(response(new URL(input, 'http://localhost').searchParams.get('mediaType')!))));
  vi.stubGlobal('fetch', fetcher);
  const wrapper = host();
  await flushPromises();
  await wrapper.get('.watchlist-remove').trigger('click');
  expect(wrapper.get('.watchlist-remove').attributes('disabled')).toBeDefined();
  rejectSave(new Error('offline'));
  await flushPromises();
  expect(wrapper.findAll('.watchlist-entry')).toHaveLength(1);
  expect(wrapper.get('[role="alert"]').text()).toContain('想看清单');
  expect(wrapper.get('.watchlist-remove').attributes('disabled')).toBeUndefined();
  wrapper.unmount();
});

it('retains a row and its count when removal fails', async () => {
  setLocale('en-US');
  vi.stubGlobal('fetch', vi.fn((input: string, options?: RequestInit) => options?.method === 'DELETE'
    ? Promise.reject(new Error('offline'))
    : Promise.resolve(Response.json(response(new URL(input, 'http://localhost').searchParams.get('mediaType')!)))));
  const wrapper = host();
  await flushPromises();
  await wrapper.get('.watchlist-remove').trigger('click');
  await flushPromises();
  expect(wrapper.findAll('.watchlist-entry')).toHaveLength(1);
  expect(wrapper.findAll('.watchlist-count').map((badge) => badge.text())).toEqual(['21', '3']);
  expect(wrapper.get('[role="alert"]').text()).toContain('Could not update your watch list');
  wrapper.unmount();
});
