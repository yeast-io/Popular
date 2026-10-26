// @vitest-environment happy-dom
import { mount, flushPromises } from '@vue/test-utils';
import { it, expect, vi, afterEach } from 'vitest';
import App from '../../App.vue';
import { setLocale } from '../../i18n';

let wrapper: ReturnType<typeof mount> | undefined;
afterEach(() => {
  wrapper?.unmount();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState({}, '', '/');
});
it('TV cards navigate separately from movie IDs and direct detail links survive popstate', async () => {
  window.history.replaceState({}, '', '/tv-shows');
  setLocale('en-US');
  vi.stubGlobal('scrollTo', vi.fn());
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/auth/me'))
      return new Response(null, { status: 401 });
    if (url.includes('/tv-shows/trending'))
      return Response.json({ items: [{ mediaType: 'tv', tmdbId: 42, name: 'TV Series' }], page: 1, hasMore: false, generation: 'x' });
    if (url.includes('/tv-shows/42'))
      return Response.json({ mediaType: 'tv', tmdbId: 42, name: 'TV Series Detail', seasons: [], genres: [], stale: false });
    return Response.json({ items: [], page: 1, hasMore: false });
  }));
  wrapper = mount(App);
  await flushPromises();
  await wrapper.get('.tv-show-card').trigger('click');
  await flushPromises();
  expect(window.location.pathname).toBe('/tv-shows/42');
  expect(wrapper.text()).toContain('TV Series Detail');
  window.history.replaceState({}, '', '/tv-shows');
  window.dispatchEvent(new PopStateEvent('popstate'));
  await flushPromises();
  expect(wrapper.find('.tv-show-card').exists()).toBe(true);
  window.history.replaceState({}, '', '/tv-shows/42');
  window.dispatchEvent(new PopStateEvent('popstate'));
  await flushPromises();
  expect(wrapper.text()).toContain('TV Series Detail');
});

it('Movies and TV Shows have separate routes, requests, cached lists and scroll positions', async () => {
  window.history.replaceState({}, '', '/movies');
  setLocale('en-US');
  let scrollY = 0;
  Object.defineProperty(window, 'scrollY', { configurable: true, get: () => scrollY });
  vi.stubGlobal('scrollTo', vi.fn((options?: ScrollToOptions) => {
    scrollY = options?.top ?? 0;
  }));
  const requests: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    requests.push(url);
    if (url.endsWith('/auth/me')) return new Response(null, { status: 401 });
    if (url.includes('/tv-shows/trending')) {
      const next = url.includes('page=2');
      return Response.json({ items: [{ mediaType: 'tv', tmdbId: next ? 43 : 42, name: next ? 'TV Second' : 'TV First' }],
        page: next ? 2 : 1, hasMore: !next, generation: '00000000-0000-4000-8000-000000000001' });
    }
    if (url.includes('/movies/')) return Response.json({ items: [{ tmdbId: 11, title: 'Only Movie', userStatus: 'unwatched' }],
      page: 1, hasMore: false, fetchedAt: new Date().toISOString(), generation: '00000000-0000-4000-8000-000000000002' });
    return Response.json({});
  }));
  wrapper = mount(App);
  await flushPromises();
  expect(wrapper.get('button[aria-current="page"]').text()).toBe('Movies');
  expect(wrapper.text()).not.toContain('Discover');
  expect(wrapper.find('.tv-section').exists()).toBe(false);
  expect(requests.some((url) => url.includes('/tv-shows/'))).toBe(false);
  scrollY = 640;
  await wrapper.findAll('button').find((button) => button.text() === 'TV Shows')!.trigger('click');
  await flushPromises();
  await new Promise((resolve) => window.requestAnimationFrame(resolve));
  expect(window.location.pathname).toBe('/tv-shows');
  expect(wrapper.get('button[aria-current="page"]').text()).toBe('TV Shows');
  expect(wrapper.find('section[aria-label="Movies"]').exists()).toBe(false);
  await wrapper.get('.tv-load-more button').trigger('click');
  await flushPromises();
  expect(wrapper.findAll('.tv-show-card')).toHaveLength(2);
  scrollY = 980;
  await wrapper.findAll('button').find((button) => button.text() === 'Movies')!.trigger('click');
  await flushPromises();
  await new Promise((resolve) => window.requestAnimationFrame(resolve));
  expect(window.location.pathname).toBe('/movies');
  expect(wrapper.text()).toContain('Only Movie');
  expect(wrapper.find('.tv-section').exists()).toBe(false);
  expect(window.scrollTo).toHaveBeenLastCalledWith({ top: 640, behavior: 'auto' });
  await wrapper.findAll('button').find((button) => button.text() === 'TV Shows')!.trigger('click');
  await flushPromises();
  await new Promise((resolve) => window.requestAnimationFrame(resolve));
  expect(wrapper.findAll('.tv-show-card')).toHaveLength(2);
  expect(requests.filter((url) => url.includes('/tv-shows/trending'))).toHaveLength(2);
  expect(requests.filter((url) => url.includes('/movies/trending'))).toHaveLength(1);
  expect(window.scrollTo).toHaveBeenLastCalledWith({ top: 980, behavior: 'auto' });
});

it.each([
  ['en-US', 'TV Shows', '← Back to TV Shows'],
  ['zh-CN', '电视剧', '← 返回电视剧'],
] as const)('a direct TV detail visit returns to its own list in %s', async (locale, label, backLabel) => {
  window.history.replaceState({}, '', '/tv-shows/42');
  setLocale(locale);
  vi.stubGlobal('scrollTo', vi.fn());
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/auth/me')) return new Response(null, { status: 401 });
    if (url.includes('/tv-shows/42')) return Response.json({ mediaType: 'tv', tmdbId: 42, name: 'Direct TV', genres: [], seasons: [] });
    return Response.json({ items: [], page: 1, hasMore: false });
  }));
  wrapper = mount(App);
  await flushPromises();
  expect(wrapper.get('button[aria-current="page"]').text()).toBe(label);
  await wrapper.findAll('button').find((button) => button.text() === backLabel)!.trigger('click');
  await flushPromises();
  expect(window.location.pathname).toBe('/tv-shows');
  expect(wrapper.find('.tv-section').exists()).toBe(true);
  expect(wrapper.find('section[aria-label="Movies"]').exists()).toBe(false);
});
