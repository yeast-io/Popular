// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, expect, it, vi } from 'vitest';
import App from './App.vue';
import { setLocale } from './i18n';

let wrapper: ReturnType<typeof mount> | undefined;
let host: HTMLDivElement | undefined;

afterEach(() => {
  wrapper?.unmount();
  host?.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState({}, '', '/');
});

it.each(['en-US', 'zh-CN'] as const)('uses the mobile scroll container for navigation, restoration and page edges (%s)', async (locale) => {
  setLocale(locale);
  window.history.replaceState({}, '', '/');
  vi.stubGlobal('scrollTo', vi.fn());
  host = document.createElement('div');
  host.id = 'app';
  host.style.overflowY = 'auto';
  Object.defineProperties(host, {
    scrollHeight: { value: 3000 },
    clientHeight: { value: 800 },
  });
  const container = host;
  const scrollTo = vi.fn((options?: ScrollToOptions | number, top?: number) => {
    container.scrollTop = Math.min(typeof options === 'number' ? (top ?? 0) : (options?.top ?? 0), 2200);
    container.dispatchEvent(new Event('scroll'));
  });
  host.scrollTo = scrollTo;
  document.body.append(host);
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/auth/me')) return new Response(null, { status: 401 });
    if (url.includes('/movies/42')) return Response.json({
      tmdbId: 42, title: 'Film detail', genres: [], cast: [], directors: [],
    });
    return Response.json({
      items: [{ tmdbId: 42, title: 'Film', userStatus: 'unwatched' }],
      page: 1, hasMore: false, source: 'cache', resultCompleteness: 'complete',
      fetchedAt: '2026-10-12T00:00:00.000Z', generation: '00000000-0000-4000-8000-000000000001', locale,
    });
  }));
  wrapper = mount(App, { attachTo: host });
  await flushPromises();
  container.scrollTop = 640;
  await wrapper.get('.movie-card').trigger('click');
  await flushPromises();
  expect(window.history.state).toMatchObject({ movieOrigin: 'movies' });
  expect(scrollTo).toHaveBeenLastCalledWith({ top: 0, behavior: 'smooth' });

  window.history.replaceState({}, '', '/');
  window.dispatchEvent(new PopStateEvent('popstate'));
  await flushPromises();
  await new Promise((resolve) => window.requestAnimationFrame(resolve));
  expect(scrollTo).toHaveBeenLastCalledWith({ top: 640, behavior: 'auto' });
  container.dispatchEvent(new Event('scroll'));
  await new Promise((resolve) => window.requestAnimationFrame(resolve));
  await flushPromises();
  const bottomLabel = locale === 'zh-CN' ? '跳到页面底部' : 'Go to the bottom of the page';
  const bottomButton = wrapper.findAll('.scroll-controls button').find((button) => button.attributes('aria-label') === bottomLabel);
  expect(bottomButton).toBeDefined();
  await bottomButton!.trigger('click');
  expect(scrollTo).toHaveBeenLastCalledWith({ top: 3000, behavior: 'smooth' });
  expect(window.scrollTo).not.toHaveBeenCalled();
});
