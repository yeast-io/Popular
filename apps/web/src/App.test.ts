// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App.vue';
import { setLocale, useI18n } from './i18n';

const fetchedAt = '2026-10-12T00:00:00.000Z';
const trendingGeneration = '00000000-0000-4000-8000-000000000001';

describe('introduction homepage navigation', () => {
  let signedIn = false;
  const account = { id: 'homepage-user', email: 'viewer@example.com', displayName: 'Viewer' };

  beforeEach(() => {
    signedIn = false;
    setLocale('zh-CN');
    window.history.replaceState({}, '', '/');
    vi.stubGlobal('scrollTo', vi.fn());
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/config')) return Response.json({ aiAssistantEnabled: false, notificationTestEnabled: false });
      if (url.endsWith('/auth/me')) return signedIn ? Response.json({ user: account }) : new Response(null, { status: 401 });
      if (url.endsWith('/auth/login')) return Response.json({ user: account });
      if (url.endsWith('/auth/logout')) return new Response(null, { status: 204 });
      throw new Error(`Unexpected homepage request: ${url}`);
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('shows the introduction without loading movie data, preserves guest browsing and handles history', async () => {
    const wrapper = mount(App, { global: { stubs: { MovieBrowser: true } } });
    await flushPromises();
    expect(wrapper.get('h1').text()).toContain('一个下载入口');
    expect(vi.mocked(fetch).mock.calls.every(([url]) => /\/(config|auth\/me)$/.test(String(url)))).toBe(true);
    await wrapper.get('.lp-text-button').trigger('click');
    expect(window.location.pathname).toBe('/movies');
    expect(wrapper.find('movie-browser-stub').exists()).toBe(true);
    window.history.replaceState({}, '', '/');
    window.dispatchEvent(new PopStateEvent('popstate'));
    await flushPromises();
    expect(wrapper.find('.lp').exists()).toBe(true);
    await wrapper.get('.lp-hero-actions .lp-button').trigger('click');
    expect(window.location.pathname).toBe('/login');
    expect(wrapper.find('#auth-email').exists()).toBe(true);
    await wrapper.get('.auth-page .back-button').trigger('click');
    await wrapper.get('.lp-signin').trigger('click');
    await wrapper.get('#auth-email').setValue('viewer@example.com');
    await wrapper.get('#auth-password').setValue('a-secure-password');
    await wrapper.get('.auth-card form').trigger('submit');
    await flushPromises();
    expect(wrapper.find('.lp').exists()).toBe(false);
    expect(wrapper.find('movie-browser-stub').exists()).toBe(true);
    await wrapper.get('.account-signout-group button').trigger('click');
    await flushPromises();
    expect(window.location.pathname).toBe('/');
    expect(wrapper.find('.lp').exists()).toBe(true);
    wrapper.unmount();
  });

  it('opens the public Agent guide from home and supports direct visits and browser history', async () => {
    let wrapper = mount(App);
    await flushPromises();
    await wrapper.get('.la-link').trigger('click');
    expect(window.location.pathname).toBe('/link-agent');
    expect(wrapper.get('h1').text()).toContain('下载器在本地');
    expect(wrapper.findAll('.agent-header')).toHaveLength(1);
    expect(wrapper.find('.site-header').exists()).toBe(false);
    expect(wrapper.get('.agent-steps').text()).toContain('Gateway');
    await wrapper.get('.agent-language').trigger('click');
    expect(wrapper.get('h1').text()).toContain('Your downloader stays local');
    await wrapper.get('.agent-language').trigger('click');
    wrapper.unmount();
    wrapper = mount(App);
    await flushPromises();
    expect(wrapper.get('h1').text()).toContain('下载器在本地');
    expect(vi.mocked(fetch).mock.calls.every(([url]) => /\/(config|auth\/me)$/.test(String(url)))).toBe(true);
    window.history.replaceState({}, '', '/');
    window.dispatchEvent(new PopStateEvent('popstate'));
    await flushPromises();
    expect(wrapper.find('.lp').exists()).toBe(true);
    await wrapper.get('.la-link').trigger('click');
    await wrapper.get('.agent-signin').trigger('click');
    expect(window.location.pathname).toBe('/login');
    wrapper.unmount();
  });

  it('opens the existing app for a returning signed-in user at the root URL', async () => {
    signedIn = true;
    const wrapper = mount(App, { global: { stubs: { MovieBrowser: true } } });
    await flushPromises();
    expect(wrapper.find('.lp').exists()).toBe(false);
    expect(wrapper.find('movie-browser-stub').exists()).toBe(true);
    expect(wrapper.find('.account-menu').exists()).toBe(true);
    wrapper.unmount();
  });
});

describe('movie detail navigation', () => {
  let scrollY = 0;

  beforeEach(() => {
    setLocale('zh-CN');
    window.history.replaceState({}, '', '/movies');
    Object.defineProperty(window, 'scrollY', { configurable: true, get: () => scrollY });
    vi.stubGlobal(
      'scrollTo',
      vi.fn((options?: ScrollToOptions | number) => {
        if (typeof options === 'object' && typeof options.top === 'number') scrollY = options.top;
      })
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/auth/me')) return new Response(null, { status: 401 });
        if (url.includes('/movies/search')) {
          return Response.json({
            items: [{ tmdbId: 42, title: '搜索结果', userStatus: 'unwatched' }],
            page: 1,
            hasMore: false,
            source: 'tmdb',
            resultCompleteness: 'complete',
            locale: 'zh-CN',
          }
          );
        }
        if (url.includes('/movies/42')) {
          return Response.json({
            tmdbId: 42,
            title: '电影详情',
            genres: [],
            cast: [],
            directors: [],
            userStatus: 'unwatched',
            detailSyncedAt: fetchedAt,
            stale: false,
            locale: 'zh-CN',
          }
          );
        }
        return Response.json({
          items: [{ tmdbId: 42, title: '热门电影', userStatus: 'unwatched' }],
          page: 1,
          hasMore: false,
          source: 'cache',
          resultCompleteness: 'complete',
          fetchedAt,
          generation: trendingGeneration,
          locale: 'zh-CN',
        }
        );
      })
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('keeps the list query and restores its scroll position after returning from a detail page', async () => {
    const replaceState = vi.spyOn(window.history, 'replaceState');
    const wrapper = mount(App);
    await flushPromises();

    await wrapper.get('.floating-search-toggle').trigger('click');
    const search = wrapper.get('input[type="search"]');
    await search.setValue('galaxy');
    await new Promise((resolve) => window.setTimeout(resolve, 310));
    await flushPromises();
    expect(wrapper.text()).toContain('搜索结果');

    scrollY = 640;
    await wrapper.get('.movie-card').trigger('click');
    await flushPromises();
    expect(window.location.pathname).toBe('/movies/42');
    expect(replaceState).toHaveBeenLastCalledWith(expect.objectContaining({ listPage: 'movies', scrollY: 640 }), '');

    window.history.replaceState({ listPage: 'movies', scrollY: 640 }, '', '/movies');
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

  it('redirects a signed-out settings visit to login and opens Movies after authentication', async () => {
    window.history.replaceState({}, '', '/settings');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/auth/me')) return new Response(null, { status: 401 });
        if (url.endsWith('/auth/login')) return Response.json({ user: authenticatedUser });
        throw new Error(`Unexpected request: ${url}`);
      })
    );

    const wrapper = mount(App);
    await flushPromises();

    expect(window.location.pathname).toBe('/login');

    await wrapper.get('#auth-email').setValue('daniel@example.com');
    await wrapper.get('#auth-password').setValue('a-secure-password');
    await wrapper.get('.auth-card form').trigger('submit');
    await flushPromises();

    expect(window.location.pathname).toBe('/');
    expect(wrapper.get('input[type="search"]').attributes('placeholder')).toBe('Search movies…');
    wrapper.unmount();
  });

  it('keeps profile saving disabled until the user changes a setting', async () => {
    window.history.replaceState({}, '', '/settings');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/auth/me')) return Response.json({ user: authenticatedUser });
        throw new Error(`Unexpected request: ${url}`);
      })
    );

    const wrapper = mount(App);
    await flushPromises();

    const saveButton = wrapper.get<HTMLButtonElement>('.settings-actions .primary');
    expect(saveButton.element.disabled).toBe(true);
    expect(wrapper.find('#profile-email').exists()).toBe(false);

    await wrapper.get('#profile-display-name').setValue('Daniel Sun');
    expect(saveButton.element.disabled).toBe(false);
    wrapper.unmount();
  });

  it('loads the avatar byte limit from the API configuration', async () => {
    window.history.replaceState({}, '', '/settings');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/auth/me')) return Response.json({ user: authenticatedUser });
        if (url.endsWith('/config'))
          return Response.json({ avatar: { maxBytes: 50 * 1024 * 1024, maxPixels: 16_777_216 } });
        throw new Error(`Unexpected request: ${url}`);
      })
    );

    const wrapper = mount(App);
    await flushPromises();

    expect(wrapper.get('.profile-avatar-actions small').text()).toContain('50 MB');
    const input = wrapper.get<HTMLInputElement>('.profile-avatar-actions input[type="file"]');
    const oversizedFile = new File([new Uint8Array([137, 80, 78, 71])], 'large.png', { type: 'image/png' });
    Object.defineProperty(oversizedFile, 'size', { value: 50 * 1024 * 1024 + 1 });
    Object.defineProperty(input.element, 'files', {
      configurable: true,
      value: [oversizedFile],
    });
    await input.trigger('change');
    expect(wrapper.text()).toContain('50 MB or smaller');
    wrapper.unmount();
  });

  it('opens personal usage from the account menu and renders an unknown provider', async () => {
    window.history.replaceState({}, '', '/settings');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/auth/me')) return Response.json({ user: authenticatedUser });
        if (url.endsWith('/me/external-usage?days=30')) {
          return Response.json({
            range: { days: 30, from: '2026-09-14', to: '2026-10-13', timezone: 'UTC', retentionDays: 90 },
            totals: { requests: 3, successes: 2, failures: 1, averageDurationMs: 400 },
            providers: [{ provider: 'future_tracker', requests: 3, successes: 2, failures: 1, averageDurationMs: 400 }],
            daily: Array.from({ length: 30 }, (_, index) => {
              const date = new Date('2026-09-14T00:00:00.000Z');
              date.setUTCDate(date.getUTCDate() + index);
              return {
                date: date.toISOString().slice(0, 10),
                providers: index === 29 ? [{ provider: 'future_tracker', requests: 3, successes: 2, failures: 1 }] : [],
              };
            }),
            operations: [
              {
                provider: 'future_tracker',
                operation: 'torrent.search',
                requests: 3,
                successes: 2,
                failures: 1,
                averageDurationMs: 400,
              },
            ],
          }
          );
        }
        throw new Error(`Unexpected request: ${url}`);
      })
    );

    const wrapper = mount(App);
    await flushPromises();

    const menu = wrapper.get<HTMLDetailsElement>('.account-menu');
    expect(menu.element.open).toBe(false);
    expect(menu.get('.account-trigger').find('.account-chevron').exists()).toBe(false);
    expect(menu.get('.account-tooltip').text()).toBe('Daniel');
    expect(menu.get('.account-identity-copy strong').text()).toBe('Daniel');
    expect(menu.get('.account-identity-copy small').text()).toBe('daniel@example.com');
    menu.element.open = true;
    await menu.findAll('.account-options button').find((button) => button.text() === 'Usage')!.trigger('click');
    await flushPromises();

    expect(window.location.pathname).toBe('/usage');
    expect(menu.element.open).toBe(false);
    expect(wrapper.get('#usage-title').text()).toBe('Usage statistics');
    expect(wrapper.text()).toContain('future_tracker');
    expect(wrapper.text()).toContain('torrent.search');
    const dateTicks = wrapper.findAll('.usage-day time');
    expect(dateTicks).toHaveLength(7);
    expect(dateTicks[0]?.attributes('datetime')).toBe('2026-09-14');
    expect(dateTicks.at(-1)?.attributes('datetime')).toBe('2026-10-13');
    wrapper.unmount();
  });
});

describe('header language control', () => {
  beforeEach(() => {
    setLocale('zh-CN');
    window.history.replaceState({}, '', '/');
    vi.stubGlobal('scrollTo', vi.fn());
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).endsWith('/auth/me')) return new Response(null, { status: 401 });
        return Response.json({
          items: [],
          page: 1,
          hasMore: false,
          source: 'cache',
          resultCompleteness: 'complete',
          fetchedAt,
          generation: trendingGeneration,
          locale: String(input).includes('locale=en-US') ? 'en-US' : 'zh-CN',
        }
        );
      })
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('removes the language control from the header', async () => {
    const wrapper = mount(App);
    await flushPromises();
    expect(wrapper.find('.site-header .locale-switcher').exists()).toBe(false);
    expect(wrapper.find('.site-header .locale-options').exists()).toBe(false);
    wrapper.unmount();
  });
});

describe('settings workspace', () => {
  beforeEach(() => {
    setLocale('en-US');
    window.history.replaceState({}, '', '/settings');
    vi.stubGlobal('scrollTo', vi.fn());
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/auth/me'))
          return Response.json({ user: { id: 'settings-user', email: 'test@example.com', displayName: 'Daniel' } });
        if (url.endsWith('/config')) return Response.json({ avatar: { maxBytes: 52428800, maxPixels: 16777216 } });
        if (url.endsWith('/me/preferences')) return Response.json({
          version: 2, autoMaintain: true, entries: [], withdrawn: [], revisions: [],
          generatedAt: null, generatedFingerprint: null, updatedAt: null, text: '',
          ratedCount: 0, minimumRatings: 5, marksChanged: false, task: null,
        });
        if (url.endsWith('/resource-search/sources')) return Response.json({ sources: [] });
        if (url.endsWith('/resource-sites/hdarea')) return Response.json({ site: 'hdarea', status: 'unconfigured' });
        if (url.endsWith(
          '/remote-client'
        )) return Response.json(
          { hasKey: false, canReadKey: false, authVersion: 0, deviceLimit: 1, devices: [], gatewayNotificationPending: false }
        );
        if (url.endsWith('/openai')) return Response.json({ configured: false });
        if (url.endsWith('/telegram')) return Response.json({ status: 'unbound' });
        if (url.endsWith('/whatsapp')) return Response.json({ status: 'unbound' });
        if (url.endsWith('/integrations/qbittorrent/instances')) return Response.json([{
          provider: 'qbittorrent', status: 'configured_valid', downloaderInstanceId: '00000000-0000-4000-8000-000000000001', name: 'qBittorrent',
          baseUrl: 'https://qb.example.com', authMethod: 'api_key', apiKeyMasked: '••••',
        }]);
        if (url.endsWith('/integrations/transmission/instances')) return Response.json([{
          provider: 'transmission', status: 'configured_valid', downloaderInstanceId: '00000000-0000-4000-8000-000000000002', name: 'Transmission',
          baseUrl: 'https://tr.example.com', username: 'user', passwordMasked: '••••',
        }]);
        if (url.endsWith('/notifications'))
          return Response.json({
            enabled: false,
            defaultChannel: 'whatsapp',
            additionalChannels: [],
            channels: [{ id: 'whatsapp', name: 'WhatsApp', configured: false }],
          }
          );
        const provider = url.split('/').at(-1);
        return Response.json({ provider, status: 'unconfigured' });
      })
    );
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each(['en-US', 'zh-CN'] as const)('shows system language in desktop and mobile settings (%s)', async (locale) => {
    setLocale(locale);
    const wrapper = mount(App);
    await flushPromises();
    await wrapper.get('[data-settings-section="language"]').trigger('click');
    const label = locale === 'zh-CN' ? '系统语言' : 'System language';
    expect(wrapper.get('.settings-content-heading h2').text()).toBe(label);
    expect(wrapper.get('#settings-category option[value="language"]').text()).toBe(label);
    expect(window.location.search).toBe('?section=language');
    expect(wrapper.get('.locale-options').isVisible()).toBe(true);
    expect(wrapper.findAll('.locale-card-title').map((node) => node.text())).toEqual(['简体中文', 'English']);
    expect(wrapper.findAll('.locale-options input[type="radio"]')).toHaveLength(2);
    await wrapper.get('#settings-category').setValue('profile');
    expect(wrapper.get('.locale-options').element.closest('.settings-form')?.getAttribute('style')).toContain('display: none');
    wrapper.unmount();
  });

  it.each(['en-US', 'zh-CN'] as const)('keeps Tools selected after a reload (%s)', async (locale) => {
    setLocale(locale);
    let wrapper = mount(App);
    await flushPromises();
    await wrapper.get('[data-settings-section="downloads"]').trigger('click');
    await flushPromises();
    expect(window.location.search).toBe('?section=tools');
    wrapper.unmount();

    wrapper = mount(App);
    await flushPromises();
    expect(wrapper.get('[data-settings-section="downloads"]').attributes('aria-current')).toBe('page');
    expect(wrapper.get('.settings-content-heading h2').text()).toBe(locale === 'zh-CN' ? '工具' : 'Tools');
    expect(wrapper.findAll('.connection-copy h3').map((heading) => heading.text())).toEqual(['qBittorrent', 'Transmission']);
    wrapper.unmount();
  });

  it.each([
    ['profile', 'profile'],
    ['ai-assistant', 'ai'],
    ['movie-preferences', 'preferences'],
    ['sources', 'resources'],
    ['tools', 'downloads'],
    ['keys', 'keys'],
    ['messages', 'notifications'],
    ['unknown', 'profile'],
    ['downloads', 'profile'],
  ])('restores the section from its public name %s', async (slug, section) => {
    window.history.replaceState({}, '', `/settings?section=${slug}`);
    const wrapper = mount(App);
    await flushPromises();
    expect(wrapper.get(`[data-settings-section="${section}"]`).attributes('aria-current')).toBe('page');
    wrapper.unmount();
  });

  it('syncs settings selection on history navigation and retains other URL parameters', async () => {
    window.history.replaceState({}, '', '/settings?section=tools&source=test');
    const wrapper = mount(App);
    await flushPromises();
    await wrapper.get('[data-settings-section="keys"]').trigger('click');
    await flushPromises();
    expect(window.location.search).toBe('?section=keys&source=test');

    window.history.replaceState({}, '', '/settings?section=tools&source=test');
    window.dispatchEvent(new PopStateEvent('popstate'));
    await flushPromises();
    expect(wrapper.get('.settings-content-heading h2').text()).toBe('Tools');
    window.history.replaceState({}, '', '/settings?section=keys&source=test');
    window.dispatchEvent(new PopStateEvent('popstate'));
    await flushPromises();
    expect(wrapper.get('.settings-content-heading h2').text()).toBe('Keys');
    wrapper.unmount();
  });

  it('groups settings by purpose, loads categories on demand and preserves unsaved drafts', async () => {
    const wrapper = mount(App, { attachTo: document.body });
    await flushPromises();
    expect(wrapper.get('.settings-content-heading h2').text()).toBe('Profile');
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes('/integrations/'))).toBe(false);
    await wrapper.get('#profile-display-name').setValue('Unsaved profile');
    await wrapper.get('[data-settings-section="ai"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('.settings-content-heading h2').text()).toBe('AI Assistant');
    expect(wrapper.get('.integration-disclosure').attributes('aria-expanded')).toBe('false');
    expect(wrapper.get('#openai-api-key').isVisible()).toBe(false);
    await wrapper.get('.integration-disclosure').trigger('click');
    await wrapper.get('#openai-api-key').setValue('sk-unsaved-personal-key');
    await wrapper.get('[data-settings-section="downloads"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('.settings-content-heading h2').text()).toBe('Tools');
    expect(wrapper.get('.settings-add-downloader').attributes('aria-label')).toBe('Add downloader');
    expect(wrapper.get('.settings-add-downloader').find('svg').exists()).toBe(true);
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false);
    await wrapper.get('.settings-add-downloader').trigger('click');
    expect(wrapper.get('[role="dialog"]').attributes('aria-modal')).toBe('true');
    expect(wrapper.find('.downloader-type-picker').exists()).toBe(true);
    expect(
      wrapper.findAll('.connection-copy h3').filter((node) => node.isVisible()).map((node) => node.text())
    ).toEqual([
      'qBittorrent', 'Transmission',
    ]
    );
    expect(wrapper.get('#openai-api-key').isVisible()).toBe(false);
    await wrapper.get('[data-settings-section="ai"]').trigger('click');
    expect(wrapper.get('#openai-api-key').element).toHaveProperty('value', 'sk-unsaved-personal-key');
    await wrapper.get('[data-settings-section="profile"]').trigger('click');
    expect(wrapper.get('#profile-display-name').element).toHaveProperty('value', 'Unsaved profile');
    expect(wrapper.get('.settings-actions .primary').element).toHaveProperty('disabled', false);
    wrapper.unmount();
  });

  it.each([
    ['en-US', 'Sources', 'Tools', 'Keys'],
    ['zh-CN', '资源', '工具', '密钥'],
  ] as const)('separates sources and tools in desktop and mobile navigation (%s)', async (locale, resources, tools, keys) => {
    setLocale(locale);
    const wrapper = mount(App, { attachTo: document.body });
    await flushPromises();
    expect(wrapper.get('[data-settings-section="resources"]').text()).toContain(resources);
    expect(wrapper.get('[data-settings-section="downloads"]').text()).toContain(tools);
    await wrapper.get('[data-settings-section="resources"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('.settings-content-heading h2').text()).toBe(resources);
    expect(wrapper.find('.resource-search').exists()).toBe(false);
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith('/resource-search/sources'))).toBe(false);
    expect(wrapper.findAll('.connection-copy h3').map((node) => node.text())).toEqual(['M-Team', 'HDArea']);
    expect(vi.mocked(fetch).mock.calls.some(([url]) => /\/(qbittorrent|transmission)$/.test(String(url)))).toBe(false);
    await wrapper.get('#settings-category').setValue('downloads');
    await flushPromises();
    expect(wrapper.get('.settings-content-heading h2').text()).toBe(tools);
    expect(
      wrapper.findAll('.connection-copy h3').filter((node) => node.isVisible()).map((node) => node.text())
    ).toEqual([
      'qBittorrent', 'Transmission',
    ]
    );
    expect(wrapper.find('#remote-client').exists()).toBe(false);
    expect(wrapper.get('[data-settings-section="keys"]').text()).toContain(keys);
    await wrapper.get('[data-settings-section="keys"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('.settings-content-heading h2').text()).toBe(keys);
    expect(wrapper.get('#remote-client').isVisible()).toBe(true);
    await wrapper.get('#remote-client .integration-disclosure').trigger('click');
    expect(wrapper.get('[data-action="generate"]').text()).toContain('RCCK');
    await wrapper.get('#settings-category').setValue('downloads');
    expect(wrapper.get('#remote-client').isVisible()).toBe(false);
    await wrapper.get('#settings-category').setValue('keys');
    await flushPromises();
    expect(wrapper.get('#remote-client').isVisible()).toBe(true);
    await wrapper.get('#settings-category').setValue('resources');
    expect(
      wrapper.findAll('.connection-copy h3').filter((node) => node.isVisible()).map((node) => node.text())
    ).toEqual(
      ['M-Team', 'HDArea']
    );
    wrapper.unmount();
  });

  it('preserves an unsaved generated key across collapse and settings category switches', async () => {
    const baseFetch = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/remote-client/generate')) return Response.json({
        configuration: { hasKey: true, canReadKey: true, authVersion: 1, deviceLimit: 1, devices: [], gatewayNotificationPending: false }, apiKey: 'test-only-rcck',
      }
      );
      return baseFetch(input, init);
    })
    );
    const wrapper = mount(App, { attachTo: document.body });
    await flushPromises();
    await wrapper.get('[data-settings-section="keys"]').trigger('click');
    await flushPromises();
    const disclosure = () => wrapper.get('#remote-client .integration-disclosure');
    expect(disclosure().attributes('aria-expanded')).toBe('false');
    await disclosure().trigger('click');
    await wrapper.get('[data-action="generate"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('#remote-client-api-key').isVisible()).toBe(true);
    await disclosure().trigger('click');
    expect(wrapper.get('#remote-client-api-key').isVisible()).toBe(false);
    await disclosure().trigger('click');
    expect(wrapper.get('#remote-client-api-key').element).toHaveProperty('value', 'test-only-rcck');
    await wrapper.get('[data-settings-section="downloads"]').trigger('click');
    await flushPromises();
    await wrapper.get('[data-settings-section="keys"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('#remote-client-api-key').isVisible()).toBe(true);
    expect(wrapper.get('#remote-client-api-key').element).toHaveProperty('value', 'test-only-rcck');
    wrapper.unmount();
  });

  it.each(
    ['en-US', 'zh-CN'] as const
  )('shows connected message cards without download notification capsules in %s', async (locale) => {
    setLocale(locale);
    const baseFetch = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/telegram') || url.endsWith('/whatsapp')) return Response.json({ status: 'connected' });
      return baseFetch(input, init);
    }));
    const wrapper = mount(App, { attachTo: document.body });
    try {
      await flushPromises();
      await wrapper.get('#settings-category').setValue('notifications');
      await flushPromises();
      expect(wrapper.get('.settings-content-heading h2').text()).toBe(locale === 'zh-CN' ? '消息' : 'Messages');
      expect(wrapper.get('[aria-labelledby="telegram-title"]').isVisible()).toBe(true);
      expect(wrapper.get('[aria-labelledby="whatsapp-title"]').isVisible()).toBe(true);
      expect(wrapper.find('.download-notification-switch').exists()).toBe(false);
      expect(wrapper.find('input[role="switch"]').exists()).toBe(false);
      expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith('/notifications'))).toBe(false);
    } finally { wrapper.unmount(); }
  });

  it('supports the mobile category selector without starting a Telegram or WhatsApp binding on visit', async () => {
    const wrapper = mount(App, { attachTo: document.body });
    await flushPromises();
    await wrapper.get('#settings-category').setValue('notifications');
    await flushPromises();
    expect(wrapper.get('.settings-content-heading h2').text()).toBe('Messages');
    expect(wrapper.findAll('.connection-copy h3').map((node) => node.text())).toEqual(['Telegram', 'WhatsApp']);
    expect(wrapper.get('.integration-disclosure').text()).toContain('Link account');
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith('/bind'))).toBe(false);
    await wrapper.get('#settings-category').setValue('profile');
    expect(wrapper.get('#profile-display-name').isVisible()).toBe(true);
    wrapper.unmount();
  });

  it.each(['en-US', 'zh-CN'] as const)('stops WhatsApp pairing requests when leaving messages and refreshes on return in %s', async (locale) => {
    setLocale(locale);
    vi.useFakeTimers();
    const baseFetch = globalThis.fetch;
    const whatsappFetch = vi.fn(async () => Response.json({ status: 'pairing' }));
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/whatsapp')) return whatsappFetch();
      return baseFetch(input, init);
    }));
    const wrapper = mount(App, { attachTo: document.body, global: { stubs: { MovieBrowser: true } } });
    try {
      await flushPromises();
      await wrapper.get('#settings-category').setValue('notifications');
      await flushPromises();
      await vi.advanceTimersByTimeAsync(3_000);
      expect(whatsappFetch).toHaveBeenCalledTimes(2);
      await wrapper.get('#settings-category').setValue('profile');
      await vi.advanceTimersByTimeAsync(9_000);
      expect(whatsappFetch).toHaveBeenCalledTimes(2);
      await wrapper.get('#settings-category').setValue('notifications');
      await flushPromises();
      expect(whatsappFetch).toHaveBeenCalledTimes(3);
      await wrapper.get('.site-nav button').trigger('click');
      await vi.advanceTimersByTimeAsync(9_000);
      expect(whatsappFetch).toHaveBeenCalledTimes(3);
    } finally {
      wrapper.unmount();
      vi.useRealTimers();
    }
  });
});

describe('notification test page environment gate', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  it.each([true, false])('uses the server feature flag (%s) for the menu and direct page access', async (enabled) => {
    setLocale('en-US');
    window.history.replaceState({}, '', '/dev/notification-tests');
    vi.stubGlobal('scrollTo', vi.fn());
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input) => {
        if (String(input).endsWith('/auth/me'))
          return Response.json({ user: { id: 'alice', displayName: 'Alice', email: 'alice@example.com' } });
        if (String(input).endsWith('/config'))
          return Response.json({ notificationTestEnabled: enabled, avatar: { maxBytes: 1000, maxPixels: 1000 } });
        throw new Error('Unexpected request');
      })
    );
    const wrapper = mount(App, {
      global: { stubs: { MovieBrowser: true, NotificationTestPage: { template: '<div data-notification-test />' } } },
    }
    );
    await flushPromises();
    expect(wrapper.find('[data-notification-test]').exists()).toBe(enabled);
    expect(wrapper.findAll('.account-options button').some((button) => button.text() === 'Notification tests')).toBe(
      enabled
    );
    expect(window.location.pathname).toBe(enabled ? '/dev/notification-tests' : '/');
    wrapper.unmount();
  });
});

describe('experimental page switches', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    window.history.replaceState({}, '', '/');
  });
  it.each([
    { path: '/ai', enabled: true },
    { path: '/ai', enabled: false },
  ]
  )('gates navigation and direct access for $path when enabled=$enabled', async ({ path, enabled }) => {
    setLocale('en-US');
    window.history.replaceState({}, '', path);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).endsWith('/config'))
          return Response.json({
            aiAssistantEnabled: enabled,
            notificationTestEnabled: false,
            avatar: { maxBytes: 1000, maxPixels: 1000 },
          }
          );
        if (String(input).endsWith('/auth/me'))
          return Response.json({
            user: { id: 'alice', displayName: 'Alice', email: 'alice@example.com', avatarUrl: null },
          }
          );
        return Response.json({ items: [] });
      })
    );
    const wrapper = mount(App, {
      global: {
        stubs: {
          MovieBrowser: true,
          AiChat: { template: '<div data-ai-page />' },
        },
      },
    }
    );
    try {
      await flushPromises();
      expect(wrapper.find('[data-ai-page]').exists()).toBe(enabled);
      const labels = wrapper.findAll('.site-nav > button').map((button) => button.text());
      expect(labels.includes('AI Assistant')).toBe(enabled);
      expect(labels.includes('Docs')).toBe(false);
      expect(window.location.pathname).toBe(enabled ? path : '/');
    } finally {
      wrapper.unmount();
    }
  });
});

describe('account language', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/settings?section=language');
    setLocale('zh-CN');
    vi.stubGlobal('scrollTo', vi.fn());
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function setup(savedLocale?: 'en-US' | 'zh-CN', fail = false) {
    const saves: string[] = [];
    const account = { id: 'locale-owner', email: 'locale@example.com', displayName: 'Owner', locale: savedLocale };
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/auth/me')) return Response.json({ user: account });
      if (url.endsWith('/users/me/locale')) {
        const locale = JSON.parse(String(init?.body)).locale;
        saves.push(locale);
        if (fail) return new Response(null, { status: 503 });
        return Response.json({ user: { ...account, locale } });
      }
      if (url.endsWith('/config')) return Response.json({});
      return Response.json({ items: [], page: 1, hasMore: false, source: 'cache',
        resultCompleteness: 'complete', fetchedAt, generation: trendingGeneration, locale: 'en-US' });
    });
    vi.stubGlobal('fetch', fetcher);
    return { saves, fetcher };
  }

  it('restores account language instead of overwriting it with the browser language', async () => {
    const f = setup('en-US');
    const wrapper = mount(App);
    await flushPromises();
    expect(useI18n().locale.value).toBe('en-US');
    expect(window.localStorage.getItem('movie-hub.locale')).toBe('en-US');
    expect(f.saves).toEqual([]);
    wrapper.unmount();
  });

  it('initializes legacy accounts and persists subsequent switches in order', async () => {
    const f = setup();
    const wrapper = mount(App);
    await flushPromises();
    expect(f.saves).toEqual(['zh-CN']);
    const buttons = wrapper.findAll('.locale-options input');
    await buttons[1]!.setValue();
    await buttons[0]!.setValue();
    await flushPromises();
    expect(f.saves).toEqual(['zh-CN', 'en-US', 'zh-CN']);
    expect(wrapper.get('.locale-save-status').text()).toBe('语言设置已保存');
    expect(wrapper.get<HTMLInputElement>('.locale-options input[value="zh-CN"]').element.checked).toBe(true);
    expect(useI18n().locale.value).toBe('zh-CN');
    wrapper.unmount();
  });

  it('restores the saved account language if a language update fails', async () => {
    const f = setup('en-US', true);
    const wrapper = mount(App);
    await flushPromises();
    await wrapper.findAll('.locale-options input')[0]!.setValue();
    await flushPromises();
    expect(f.saves).toEqual(['zh-CN']);
    expect(wrapper.get<HTMLInputElement>('.locale-options input[value="en-US"]').element.checked).toBe(true);
    expect(wrapper.get('.locale-save-status').text()).toBe('Changes apply immediately and save automatically');
    expect(useI18n().locale.value).toBe('en-US');
    expect(wrapper.get('[role="alert"]').text()).toBe('The request failed. Please try again.');
    wrapper.unmount();
  });
});

describe('Watch list account navigation', () => {
  beforeEach(() => {
    setLocale('en-US');
    window.history.replaceState({}, '', '/movies');
    vi.stubGlobal('scrollTo', vi.fn());
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/auth/me')) return Response.json({ user: { id: 'owner', displayName: 'Owner', email: 'owner@example.com' } });
      if (url.endsWith('/config')) return Response.json({});
      if (url.includes('/me/movies?')) {
        const filter = new URL(url, 'http://localhost').searchParams.get('status');
        return Response.json({ items: [{ tmdbId: 42, title: `${filter} saved film`, overview: 'Saved overview' }], pagination: { page: 1, pageSize: 20, total: 1, hasMore: false }, locale: 'en-US' });
      }
      if (url.includes('/me/tv-shows/preferences?')) return Response.json({ items: [{ tmdbId: 42, mediaType: 'tv', title: 'Liked series' }], pagination: { page: 1, pageSize: 20, total: 1, hasMore: false }, locale: 'en-US' });
      if (url.includes('/movies/42?')) return Response.json({ tmdbId: 42, title: 'Saved detail', genres: [], cast: [], directors: [], userStatus: 'watched', stale: false, detailSyncedAt: fetchedAt });
      if (url.includes('/me/resource-notifications?')) return Response.json({ items: [{ id: 'notice', tmdbId: 42, mediaType: 'movie', title: 'Resource film', status: 'pending', createdAt: fetchedAt }], limit: 5, locale: 'en-US' });
      if (url.includes('/me/watchlist?')) {
        const tv = url.includes('mediaType=tv');
        return Response.json({ items: [{ tmdbId: 42, mediaType: tv ? 'tv' : 'movie', title: tv ? 'Saved series' : 'Saved film' }], pagination: { page: 1, pageSize: 20, total: 1, hasMore: false }, locale: 'en-US' });
      }
      if (url.includes('/tv-shows/42')) return Response.json({ tmdbId: 42, mediaType: 'tv', name: 'Series detail', genres: [], seasons: [], locale: 'en-US', stale: false, detailSyncedAt: fetchedAt });
      if (url.includes('/me/watchlist/tv-shows/')) return Response.json({ inWatchlist: true });
      return Response.json({ items: [], page: 1, hasMore: false, source: 'cache', resultCompleteness: 'complete', generation: trendingGeneration, fetchedAt });
    }));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  it('orders usage, separated watch list and viewing preferences without a My Movies navigation item', async () => {
    const wrapper = mount(App);
    await flushPromises();
    const actions = wrapper.findAll('.account-action-group button').map((button) => button.text());
    expect(actions.slice(0, 5)).toEqual(['Settings', 'Usage', 'Watch list', 'Resource notifications', 'Viewing preferences']);
    expect(wrapper.get('.account-library-group').findAll('button').map((button) => button.text())).toEqual(['Watch list', 'Resource notifications', 'Viewing preferences']);
    expect(wrapper.get('.site-nav').text()).not.toContain('My Movies');
    await wrapper.get('.account-library-group button:nth-child(3)').trigger('click');
    await flushPromises();
    expect(window.location.pathname).toBe('/viewing-preferences');
    expect(wrapper.get('.watchlist-entry').text()).toContain('watched saved film');
    await wrapper.get('.watchlist-filters button:nth-child(2)').trigger('click');
    await flushPromises();
    await wrapper.get('.watchlist-entry').trigger('click');
    await flushPromises();
    expect(window.history.state.movieOrigin).toBe('viewing-preferences');
    window.history.replaceState({}, '', '/viewing-preferences');
    window.dispatchEvent(new PopStateEvent('popstate'));
    await flushPromises();
    expect(wrapper.get('.watchlist-filters button:nth-child(2)').attributes('aria-pressed')).toBe('true');
    expect(wrapper.get('.watchlist-entry').text()).toContain('liked saved film');
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes('/resources/sync'))).toBe(false);
    wrapper.unmount();
  });
  it('opens resource notifications beside watch list and preserves the list origin through details', async () => {
    const wrapper = mount(App);
    await flushPromises();
    await wrapper.findAll('.account-library-group button').find((button) => button.text() === 'Resource notifications')!.trigger('click');
    await flushPromises();
    expect(window.location.pathname).toBe('/resource-notifications');
    expect(wrapper.get('.resource-notification-page').text()).toContain('Resource film');
    await wrapper.get('.resource-notification-entry').trigger('click');
    await flushPromises();
    expect(window.history.state.movieOrigin).toBe('resource-notifications');
    window.history.replaceState({}, '', '/resource-notifications');
    window.dispatchEvent(new PopStateEvent('popstate'));
    await flushPromises();
    expect(wrapper.get('.resource-notification-page').text()).toContain('Resource film');
    wrapper.unmount();
  });
  it('redirects the retired My Movies URL to viewing preferences', async () => {
    window.history.replaceState({}, '', '/my-movies');
    const wrapper = mount(App);
    await flushPromises();
    expect(window.location.pathname).toBe('/viewing-preferences');
    expect(wrapper.find('.viewing-preferences-page').exists()).toBe(true);
    wrapper.unmount();
  });
  it('opens TV details from viewing preferences and retains both navigation levels on return', async () => {
    const wrapper = mount(App);
    await flushPromises();
    await wrapper.get('.account-library-group button:nth-child(3)').trigger('click');
    await flushPromises();
    await wrapper.get('.viewing-preferences-media button:nth-child(2)').trigger('click');
    await flushPromises();
    await wrapper.get('.watchlist-entry').trigger('click');
    await flushPromises();
    expect(window.location.pathname).toBe('/tv-shows/42');
    expect(window.history.state.tvShowOrigin).toBe('viewing-preferences');
    expect(wrapper.text()).toContain('Back to viewing preferences');
    window.history.replaceState({}, '', '/viewing-preferences');
    window.dispatchEvent(new PopStateEvent('popstate'));
    await flushPromises();
    expect(wrapper.get('.viewing-preferences-media button:nth-child(2)').attributes('aria-pressed')).toBe('true');
    expect(wrapper.findAll('.watchlist-filters button')).toHaveLength(2);
    expect(wrapper.get('.watchlist-entry').text()).toContain('Liked series');
    wrapper.unmount();
  });
  it('opens the read-only list from the avatar and retains TV category after returning from detail', async () => {
    const wrapper = mount(App);
    await flushPromises();
    const menu = wrapper.get<HTMLDetailsElement>('.account-menu');
    menu.element.open = true;
    await menu.findAll('button').find((button) => button.text() === 'Watch list')!.trigger('click');
    await flushPromises();
    expect(window.location.pathname).toBe('/watchlist');
    expect(menu.element.open).toBe(false);
    expect(wrapper.text()).toContain('Saved film');
    await wrapper.get('.watchlist-filters button:nth-child(2)').trigger('click');
    await flushPromises();
    await wrapper.get('.watchlist-entry').trigger('click');
    await flushPromises();
    expect(window.location.pathname).toBe('/tv-shows/42');
    expect(window.history.state.tvShowOrigin).toBe('watchlist');
    window.history.replaceState({}, '', '/watchlist');
    window.dispatchEvent(new PopStateEvent('popstate'));
    await flushPromises();
    expect(wrapper.get('.watchlist-filters button:nth-child(2)').attributes('aria-pressed')).toBe('true');
    expect(wrapper.text()).toContain('Saved series');
    wrapper.unmount();
  });
});
