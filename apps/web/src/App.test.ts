// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App.vue';
import { setLocale } from './i18n';

const fetchedAt = '2026-10-12T00:00:00.000Z';
const trendingGeneration = '00000000-0000-4000-8000-000000000001';

describe('movie detail navigation', () => {
  let scrollY = 0;

  beforeEach(() => {
    setLocale('zh-CN');
    window.history.replaceState({}, '', '/');
    Object.defineProperty(window, 'scrollY', { configurable: true, get: () => scrollY });
    vi.stubGlobal('scrollTo', vi.fn((options?: ScrollToOptions | number) => {
      if (typeof options === 'object' && typeof options.top === 'number') scrollY = options.top;
    }));
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/auth/me')) return new Response(null, { status: 401 });
      if (url.includes('/movies/search')) {
        return Response.json({
          items: [{ tmdbId: 42, title: '搜索结果', userStatus: 'unwatched' }],
          page: 1, hasMore: false, source: 'tmdb', resultCompleteness: 'complete', locale: 'zh-CN',
        });
      }
      if (url.includes('/movies/42')) {
        return Response.json({
          tmdbId: 42, title: '电影详情', genres: [], cast: [], directors: [], userStatus: 'unwatched',
          detailSyncedAt: fetchedAt, stale: false, locale: 'zh-CN',
        });
      }
      return Response.json({
        items: [{ tmdbId: 42, title: '热门电影', userStatus: 'unwatched' }],
        page: 1, hasMore: false, source: 'cache', resultCompleteness: 'complete', fetchedAt,
        generation: trendingGeneration, locale: 'zh-CN',
      });
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('keeps the list query and restores its scroll position after returning from a detail page', async () => {
    const replaceState = vi.spyOn(window.history, 'replaceState');
    const wrapper = mount(App);
    await flushPromises();

    const search = wrapper.get('input[type="search"]');
    await search.setValue('galaxy');
    await new Promise((resolve) => window.setTimeout(resolve, 310));
    await flushPromises();
    expect(wrapper.text()).toContain('搜索结果');

    scrollY = 640;
    await wrapper.get('.movie-card').trigger('click');
    await flushPromises();
    expect(window.location.pathname).toBe('/movies/42');
    expect(replaceState).toHaveBeenLastCalledWith(expect.objectContaining({ listPage: 'home', scrollY: 640 }), '');

    window.history.replaceState({ listPage: 'home', scrollY: 640 }, '', '/');
    window.dispatchEvent(new PopStateEvent('popstate', { state: window.history.state }));
    await flushPromises();
    await new Promise((resolve) => window.requestAnimationFrame(resolve));

    expect(wrapper.get('input[type="search"]').element).toHaveProperty('value', 'galaxy');
    expect(window.scrollTo).toHaveBeenLastCalledWith({ top: 640, behavior: 'auto' });
    wrapper.unmount();
  });
});

describe('account routes', () => {
  const authenticatedUser = {
    id: 'user-1',
    email: 'daniel@example.com',
    displayName: 'Daniel',
  };

  beforeEach(() => {
    setLocale('en-US');
    vi.stubGlobal('scrollTo', vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('redirects a signed-out settings visit to login and opens Discover after authentication', async () => {
    window.history.replaceState({}, '', '/settings');
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/auth/me')) return new Response(null, { status: 401 });
      if (url.endsWith('/auth/login')) return Response.json({ user: authenticatedUser });
      throw new Error(`Unexpected request: ${url}`);
    }));

    const wrapper = mount(App);
    await flushPromises();

    expect(window.location.pathname).toBe('/login');

    await wrapper.get('#auth-email').setValue('daniel@example.com');
    await wrapper.get('#auth-password').setValue('a-secure-password');
    await wrapper.get('.auth-card form').trigger('submit');
    await flushPromises();

    expect(window.location.pathname).toBe('/');
    expect(wrapper.text()).toContain('Trending this week');
    wrapper.unmount();
  });

  it('keeps profile saving disabled until the user changes a setting', async () => {
    window.history.replaceState({}, '', '/settings');
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/auth/me')) return Response.json({ user: authenticatedUser });
      throw new Error(`Unexpected request: ${url}`);
    }));

    const wrapper = mount(App);
    await flushPromises();

    const saveButton = wrapper.get<HTMLButtonElement>('.settings-actions .primary');
    expect(saveButton.element.disabled).toBe(true);
    expect(wrapper.find('#profile-email').exists()).toBe(false);

    await wrapper.get('#profile-display-name').setValue('Daniel Sun');
    expect(saveButton.element.disabled).toBe(false);
    wrapper.unmount();
  });
});

describe('language menu', () => {
  beforeEach(() => {
    setLocale('zh-CN');
    window.history.replaceState({}, '', '/');
    vi.stubGlobal('scrollTo', vi.fn());
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/auth/me')) return new Response(null, { status: 401 });
      return Response.json({
        items: [], page: 1, hasMore: false, source: 'cache', resultCompleteness: 'complete',
        fetchedAt, generation: trendingGeneration, locale: String(input).includes('locale=en-US') ? 'en-US' : 'zh-CN',
      });
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('keeps language choices collapsed until requested and closes after selection', async () => {
    const wrapper = mount(App);
    await flushPromises();

    const menu = wrapper.get<HTMLDetailsElement>('.locale-switcher');
    expect(menu.element.open).toBe(false);
    expect(menu.find('.locale-icon').exists()).toBe(true);
    expect(menu.get('summary').attributes('aria-label')).toBe('语言: 简体中文');

    menu.element.open = true;
    await menu.get('.locale-options button:last-child').trigger('click');
    await flushPromises();

    expect(menu.element.open).toBe(false);
    expect(menu.get('summary').attributes('aria-label')).toBe('Language: English');
    expect(menu.get('.locale-options button:last-child').attributes('aria-pressed')).toBe('true');
    wrapper.unmount();
  });
});
