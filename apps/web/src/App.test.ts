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
    expect(wrapper.text()).toContain('Trending this week');
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
    await menu.get('.account-options button:nth-child(2)').trigger('click');
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

describe('language menu', () => {
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
    expect(wrapper.get('.settings-content-heading h2').text()).toBe('Downloads');
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
    ['en-US', 'Sources', 'Downloads', 'Keys'],
    ['zh-CN', '资源', '下载', '密钥'],
  ] as const)('separates sources and downloads in desktop and mobile navigation (%s)', async (locale, resources, downloads, keys) => {
    setLocale(locale);
    const wrapper = mount(App, { attachTo: document.body });
    await flushPromises();
    expect(wrapper.get('[data-settings-section="resources"]').text()).toContain(resources);
    expect(wrapper.get('[data-settings-section="downloads"]').text()).toContain(downloads);
    await wrapper.get('[data-settings-section="resources"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('.settings-content-heading h2').text()).toBe(resources);
    expect(wrapper.find('.resource-search').exists()).toBe(false);
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith('/resource-search/sources'))).toBe(false);
    expect(wrapper.findAll('.connection-copy h3').map((node) => node.text())).toEqual(['M-Team', 'HDArea']);
    expect(vi.mocked(fetch).mock.calls.some(([url]) => /\/(qbittorrent|transmission)$/.test(String(url)))).toBe(false);
    await wrapper.get('#settings-category').setValue('downloads');
    await flushPromises();
    expect(wrapper.get('.settings-content-heading h2').text()).toBe(downloads);
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
  )('places independent download switches on bound message cards in %s', async (locale) => {
    setLocale(locale);
    const baseFetch = globalThis.fetch;
    let enabled = false;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/telegram') || url.endsWith('/whatsapp')) return Response.json({ status: 'connected' });
      if (url.endsWith('/notifications')) {
        if (init?.method === 'PUT') enabled = JSON.parse(String(init.body)).enabled;
        return Response.json({ enabled, defaultChannel: 'telegram', additionalChannels: [], channels: [
          { id: 'telegram', name: 'Telegram', configured: true },
          { id: 'whatsapp', name: 'WhatsApp', configured: true },
        ] }
        );
      }
      return baseFetch(input, init);
    })
    );
    const wrapper = mount(App, { attachTo: document.body });
    try {
      await flushPromises();
      await wrapper.get('#settings-category').setValue('notifications');
      await flushPromises();
      expect(wrapper.get('.settings-content-heading h2').text()).toBe(locale === 'zh-CN' ? '消息' : 'Messages');
      const telegram = wrapper.get('[aria-labelledby="telegram-title"]');
      const whatsapp = wrapper.get('[aria-labelledby="whatsapp-title"]');
      expect(telegram.get('.download-notification-switch').isVisible()).toBe(true);
      expect(whatsapp.get('.download-notification-switch').isVisible()).toBe(true);
      await telegram.get('input[role="switch"]').setValue(true);
      await flushPromises();
      expect(enabled).toBe(true);
      expect(whatsapp.get<HTMLInputElement>('input[role="switch"]').element.checked).toBe(false);
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
