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
});
describe('Watch list', () => {
  it('renders read-only rows, switches media categories, paginates and opens correct details', async () => {
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
