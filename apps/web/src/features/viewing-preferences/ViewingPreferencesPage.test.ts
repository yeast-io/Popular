// @vitest-environment happy-dom
import { defineComponent, KeepAlive } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, expect, it, vi } from 'vitest';
import { setLocale } from '../../i18n';
import ViewingPreferencesPage from './ViewingPreferencesPage.vue';

const mounted: ReturnType<typeof mount>[] = [];
function result(status: string, page = 1) {
  return { items: [{ tmdbId: page, title: `${status} ${page}`, overview: 'Overview', releaseDate: '2020-01-01', voteAverage: 8.1 }],
    pagination: { page, pageSize: 20, total: status === 'watched' ? 21 : 1, hasMore: status === 'watched' && page === 1 }, locale: 'en-US' };
}
function host() {
  const wrapper = mount(defineComponent({ components: { ViewingPreferencesPage, KeepAlive }, data: () => ({ visible: true }), template: '<KeepAlive><ViewingPreferencesPage v-if="visible" /></KeepAlive>' }));
  mounted.push(wrapper);
  return wrapper;
}
afterEach(() => {
  mounted.splice(0).forEach((wrapper) => wrapper.unmount());
  vi.unstubAllGlobals();
});
it.each(['en-US', 'zh-CN'] as const)('renders three saved categories as read-only rows with no bulk sync requests (%s)', async (language) => {
  setLocale(language);
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost');
    return Response.json(result(url.searchParams.get('status')!, Number(url.searchParams.get('page'))));
  });
  vi.stubGlobal('fetch', fetch);
  const wrapper = host();
  await flushPromises();
  expect(wrapper.findAll('.watchlist-filters button')).toHaveLength(3);
  expect(wrapper.findAll('.watchlist-count').map((badge) => badge.text())).toEqual(['21', '1', '1']);
  expect(wrapper.get('.watchlist-entry').text()).toContain('Overview');
  expect(wrapper.find('.watchlist-entry button').exists()).toBe(false);
  await wrapper.get('.tv-load-more button').trigger('click');
  await flushPromises();
  expect(wrapper.findAll('.watchlist-entry')).toHaveLength(2);
  await wrapper.setData({ visible: false });
  await wrapper.setData({ visible: true });
  await flushPromises();
  expect(wrapper.findAll('.watchlist-entry')).toHaveLength(2);
  await wrapper.get('.watchlist-filters button:nth-child(2)').trigger('click');
  await flushPromises();
  expect(wrapper.get('.watchlist-entry').text()).toContain('liked 1');
  await wrapper.get('.watchlist-entry').trigger('click');
  expect(wrapper.getComponent(ViewingPreferencesPage).emitted('openMovie')).toEqual([[1]]);
  await wrapper.get('.watchlist-filters button:nth-child(3)').trigger('click');
  await flushPromises();
  expect(wrapper.get('.watchlist-entry').text()).toContain('disliked 1');
  expect(fetch.mock.calls.every(([url]) => String(url).includes('/me/movies?status=') && !String(url).includes('/sync'))).toBe(true);
});
it('ignores a delayed result from a previous filter', async () => {
  setLocale('en-US');
  let resolveWatched!: (response: Response) => void;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost');
    if (url.searchParams.get('status') === 'watched' && url.searchParams.get('pageSize') === '20') return new Promise<Response>((resolve) => {
      resolveWatched = resolve;
    });
    return Response.json(result(url.searchParams.get('status')!));
  }));
  const wrapper = host();
  await wrapper.get('.watchlist-filters button:nth-child(2)').trigger('click');
  await flushPromises();
  resolveWatched(Response.json(result('watched')));
  await flushPromises();
  expect(wrapper.get('.watchlist-entry').text()).toContain('liked 1');
  expect(wrapper.text()).not.toContain('watched 1');
});
it('shows localized errors, supports retry, then reloads when the locale changes', async () => {
  setLocale('zh-CN');
  let failed = true;
  const urls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    if (failed && url.includes('pageSize=20')) return new Response(null, { status: 503 });
    return Response.json({ ...result('watched'), items: [], pagination: { page: 1, pageSize: 20, total: 0, hasMore: false } });
  }));
  const wrapper = host();
  await flushPromises();
  expect(wrapper.get('[role="alert"]').text()).toContain('观影偏好加载失败');
  failed = false;
  await wrapper.get('[role="alert"] button').trigger('click');
  await flushPromises();
  expect(wrapper.text()).toContain('此分类暂无影片');
  setLocale('en-US');
  await flushPromises();
  expect(wrapper.text()).toContain('No movies in this category yet.');
  expect(urls.some((url) => url.includes('locale=en-US'))).toBe(true);
});

it.each(['en-US', 'zh-CN'] as const)('switches media with two TV filters, restores movie selection and opens TV details (%s)', async (language) => {
  setLocale(language);
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost');
    const tv = url.pathname.endsWith('/tv-shows/preferences');
    const status = url.searchParams.get(tv ? 'preference' : 'status')!;
    return Response.json({ ...result(`${tv ? 'tv' : 'movie'} ${status}`), pagination: { page: 1, pageSize: 20, total: tv ? 7 : 3, hasMore: false } });
  });
  vi.stubGlobal('fetch', fetch);
  const wrapper = host();
  await flushPromises();
  const page = wrapper.getComponent(ViewingPreferencesPage);
  expect(page.get('.viewing-preferences-media').text()).toContain(language === 'en-US' ? 'TV Shows' : '电视剧');
  await page.get('.viewing-preferences-media button:nth-child(2)').trigger('click');
  await flushPromises();
  expect(page.findAll('.watchlist-filters button')).toHaveLength(2);
  expect(page.get('.watchlist-entry').text()).toContain('tv liked');
  expect(page.findAll('.watchlist-count').map((badge) => badge.text())).toEqual(['7', '7']);
  await page.get('.watchlist-entry').trigger('click');
  expect(page.emitted('openTvShow')).toEqual([[1]]);
  expect(page.emitted('openMovie')).toBeUndefined();
  await page.get('.watchlist-filters button:nth-child(2)').trigger('click');
  await flushPromises();
  expect(page.get('.watchlist-entry').text()).toContain('tv disliked');
  await page.get('.viewing-preferences-media button:first-child').trigger('click');
  await flushPromises();
  expect(page.get('.watchlist-entry').text()).toContain('movie watched');
  for (const [index, status] of [[2, 'liked'], [3, 'disliked']] as const) {
    await page.get(`.watchlist-filters button:nth-child(${index})`).trigger('click');
    await page.get('.viewing-preferences-media button:nth-child(2)').trigger('click');
    await flushPromises();
    expect(page.get('.watchlist-entry').text()).toContain(`tv ${status}`);
    await wrapper.setData({ visible: false });
    await wrapper.setData({ visible: true });
    await flushPromises();
    expect(page.get('.watchlist-entry').text()).toContain(`tv ${status}`);
    await page.get('.viewing-preferences-media button:first-child').trigger('click');
    await flushPromises();
    expect(page.get('.watchlist-entry').text()).toContain(`movie ${status}`);
  }
  expect(fetch.mock.calls.filter(([url]) => String(url).includes('/tv-shows/preferences')).every(([url]) => !String(url).includes('watched'))).toBe(true);
});

it('ignores a delayed movie response after switching to TV and localizes TV empty states', async () => {
  setLocale('zh-CN');
  let resolveMovies!: (response: Response) => void;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/me/movies?status=watched') && url.includes('pageSize=20')) return new Promise<Response>((resolve) => {
      resolveMovies = resolve;
    });
    return Response.json({ items: [], pagination: { page: 1, pageSize: 20, total: 0, hasMore: false } });
  }));
  const wrapper = host();
  await wrapper.get('.viewing-preferences-media button:nth-child(2)').trigger('click');
  await flushPromises();
  resolveMovies(Response.json(result('watched')));
  await flushPromises();
  expect(wrapper.find('.watchlist-entry').exists()).toBe(false);
  expect(wrapper.text()).toContain('此分类暂无电视剧');
  setLocale('en-US');
  await flushPromises();
  expect(wrapper.text()).toContain('No TV shows in this category yet.');
});

it('keeps counts and old rows stable while loading but prevents opening stale results', async () => {
  setLocale('en-US');
  let resolveLiked!: (response: Response) => void;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost');
    const status = url.searchParams.get('status')!;
    if (status === 'liked' && url.searchParams.get('pageSize') === '20') return new Promise<Response>((resolve) => {
      resolveLiked = resolve;
    });
    return Response.json(result(status));
  }));
  const wrapper = host();
  await flushPromises();
  expect(wrapper.findAll('.watchlist-count').map((badge) => badge.text())).toEqual(['21', '1', '1']);
  await wrapper.get('.watchlist-filters button:nth-child(2)').trigger('click');
  expect(wrapper.get('.watchlist-entry').text()).toContain('watched 1');
  expect(wrapper.findAll('.watchlist-count').map((badge) => badge.text())).toEqual(['21', '1', '1']);
  expect(wrapper.get('.viewing-preferences-results').attributes('aria-busy')).toBe('true');
  expect(wrapper.get('.viewing-preferences-content').attributes('inert')).toBeDefined();
  await wrapper.get('.watchlist-entry').trigger('click');
  expect(wrapper.getComponent(ViewingPreferencesPage).emitted('openMovie')).toBeUndefined();
  resolveLiked(Response.json(result('liked')));
  await flushPromises();
  expect(wrapper.get('.watchlist-entry').text()).toContain('liked 1');
  expect(wrapper.get('.viewing-preferences-results').attributes('aria-busy')).toBe('false');
  expect(wrapper.get('.viewing-preferences-content').attributes('inert')).toBeUndefined();
  await wrapper.get('.watchlist-entry').trigger('click');
  expect(wrapper.getComponent(ViewingPreferencesPage).emitted('openMovie')).toEqual([[1]]);
});

it('replaces stale rows with an error when a filter switch fails and retries the selected filter', async () => {
  setLocale('zh-CN');
  let failLiked = true;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost');
    const status = url.searchParams.get('status')!;
    if (status === 'liked' && url.searchParams.get('pageSize') === '20' && failLiked) return new Response(null, { status: 503 });
    return Response.json(result(status));
  }));
  const wrapper = host();
  await flushPromises();
  await wrapper.get('.watchlist-filters button:nth-child(2)').trigger('click');
  await flushPromises();
  expect(wrapper.get('[role="alert"]').text()).toContain('观影偏好加载失败');
  expect(wrapper.find('.watchlist-entry').exists()).toBe(false);
  expect(wrapper.findAll('.watchlist-count').map((badge) => badge.text())).toEqual(['21', '1', '1']);
  failLiked = false;
  await wrapper.get('[role="alert"] button').trigger('click');
  await flushPromises();
  expect(wrapper.get('.watchlist-entry').text()).toContain('liked 1');
});
