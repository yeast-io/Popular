// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Locale } from '@movie-hub/contract';
import { setLocale } from '../../i18n';
import MovieDetail from './MovieDetail.vue';

const mounted: ReturnType<typeof mount>[] = [];
function setup(authenticated = true, fail = false) {
  const writes: { method: string; body?: unknown }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
    const url = String(input);
    if (url.includes('/status')) {
      writes.push({ method: options?.method ?? 'GET', ...(options?.body ? { body: JSON.parse(String(options.body)) } : {}) });
      return fail ? Response.json({ error: { code: 'INTERNAL_ERROR', message: 'Failure', requestId: 'test' } }, { status: 500 }) : Response.json({});
    }
    if (!url.includes('/me/') && /\/movies\/42\?/.test(url)) return Response.json({
      tmdbId: 42, title: 'Film', genres: [], cast: [], directors: [], userStatus: 'unwatched', userPreference: 'liked',
      trailer: { tmdbVideoId: 'video', provider: 'youtube', providerVideoId: 'M7lc1UVf-VE', name: 'Trailer', official: true },
      detailSyncedAt: new Date().toISOString(), stale: false, locale: 'en-US',
    });
    return Response.json({ sites: [], downloads: [], devices: [], items: [], checking: false, availability: 'unchecked' });
  }));
  const wrapper = mount(MovieDetail, { props: { tmdbId: 42, authenticated }, global: { stubs: { ResourceSiteSelector: true } } });
  mounted.push(wrapper);
  return { wrapper, writes };
}
afterEach(() => {
  mounted.splice(0).forEach((wrapper) => wrapper.unmount());
  vi.unstubAllGlobals();
});
describe('movie detail icon actions', () => {
  it.each(['en-US', 'zh-CN'] as const)('shows resource badges and queries only while signed in (%s)', async (locale) => {
    setLocale(locale);
    const { wrapper } = setup(false);
    await flushPromises();
    expect(wrapper.find('.detail-poster').exists()).toBe(true);
    expect(wrapper.find('.trailer-button').exists()).toBe(true);
    expect(wrapper.findAll('.poster-resource-badge')).toHaveLength(0);
    expect(wrapper.find('.resource-check-panel').exists()).toBe(false);
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes('/me/movies/'))).toBe(false);

    await wrapper.setProps({ authenticated: true });
    await flushPromises();
    expect(wrapper.find('.detail-poster .poster-resource-badge').exists()).toBe(true);
    expect(wrapper.find('.dossier-data > .dossier-resource button').exists()).toBe(true);
    expect(wrapper.find('.resource-check-panel').exists()).toBe(false);
    expect(wrapper.findAll('.dossier-data > div').at(-2)?.text()).toContain(locale === 'zh-CN' ? '票数' : 'Votes');
    expect(wrapper.find('.resource-site-selector').exists()).toBe(false);
    expect(wrapper.find('.resource-status-button').exists()).toBe(true);

    await wrapper.setProps({ authenticated: false });
    expect(wrapper.findAll('.poster-resource-badge')).toHaveLength(0);
    expect(wrapper.find('.resource-check-panel').exists()).toBe(false);
    expect(wrapper.find('.trailer-button').exists()).toBe(true);
  });
  it.each([
    ['en-US', 'Add to watch list', 'Remove from watch list', 'Mark as watched', 'Mark as unwatched'],
    ['zh-CN', '加入想看清单', '移出想看清单', '标记为已看', '标记为未看'],
  ] as const)('uses localized icon actions and preserves mutually exclusive statuses in %s', async (locale: Locale, add, remove, watched, unwatched) => {
    setLocale(locale);
    const { wrapper, writes } = setup();
    await flushPromises();
    expect(wrapper.get('.detail-media-actions').findAll('button').map((button) => button.classes()[0])).toEqual(['trailer-button', 'detail-state-icon', 'detail-state-icon']);
    expect(wrapper.find('.detail-preference').exists()).toBe(false);
    expect(wrapper.find('.detail-status').exists()).toBe(false);
    expect(wrapper.get('.watchlist-icon').attributes('title')).toBeUndefined();
    expect(wrapper.get('.watchlist-icon [role=tooltip]').text()).toBe(locale === 'zh-CN' ? '未加入想看清单' : 'Not in watch list');
    expect(wrapper.get('.watchlist-icon').attributes('aria-label')).toBe(add);
    expect(wrapper.get('.watchlist-icon').attributes('aria-describedby')).toBe(wrapper.get('.watchlist-icon [role=tooltip]').attributes('id'));
    await wrapper.get('.watchlist-icon').trigger('click');
    await flushPromises();
    expect(wrapper.get('.watchlist-icon').attributes('aria-label')).toBe(remove);
    expect(wrapper.get('.watchlist-icon').attributes('aria-pressed')).toBe('true');
    expect(wrapper.get('.watched-icon').attributes('aria-label')).toBe(watched);
    expect(wrapper.get('.watchlist-icon [role=tooltip]').text()).toBe(locale === 'zh-CN' ? '已加入想看清单' : 'In watch list');
    await wrapper.get('.watched-icon').trigger('click');
    await flushPromises();
    expect(wrapper.get('.watchlist-icon').attributes('aria-pressed')).toBe('false');
    expect(wrapper.get('.watched-icon').attributes('aria-label')).toBe(unwatched);
    expect(wrapper.get('.watched-icon [role=tooltip]').text()).toBe(locale === 'zh-CN' ? '已看' : 'Watched');
    await wrapper.get('.watched-icon').trigger('click');
    await flushPromises();
    expect(wrapper.get('.watched-icon').attributes('aria-pressed')).toBe('false');
    expect(writes).toEqual([{ method: 'PUT', body: { status: 'interested' } }, { method: 'PUT', body: { status: 'watched' } }, { method: 'DELETE' }]);
  });
  it('restores icon state after a failed save and leaves existing preference untouched', async () => {
    setLocale('en-US');
    const { wrapper } = setup(true, true);
    await flushPromises();
    await wrapper.get('.watchlist-icon').trigger('click');
    await flushPromises();
    expect(wrapper.get('.watchlist-icon').attributes('aria-pressed')).toBe('false');
    expect(wrapper.findAll('.detail-state-icon.active')).toHaveLength(0);
    expect(wrapper.find('[role="alert"]').exists()).toBe(true);
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes('/preference'))).toBe(false);
  });
  it('requests login without writing a status when signed out', async () => {
    const { wrapper, writes } = setup(false);
    await flushPromises();
    await wrapper.get('.watched-icon').trigger('click');
    expect(wrapper.emitted('requireLogin')).toEqual([[]]);
    expect(writes).toHaveLength(0);
  });
});

it.each(['en-US', 'zh-CN'] as const)('combines cast and directors once per person with a localized director badge (%s)', async (language) => {
  setLocale(language);
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({
    tmdbId: 42, title: 'Film', genres: [], userStatus: 'unwatched',
    directors: [{ tmdbId: 1, name: '导演演员', originalName: 'Director Actor' }],
    cast: [{ tmdbId: 1, name: 'Director Actor', character: 'Lead', profileUrl: 'https://example.com/director.jpg' },
      { tmdbId: 2, name: 'Actor', character: 'Friend' }, { tmdbId: 2, name: 'Actor', character: 'Narrator' }],
    detailSyncedAt: new Date().toISOString(), stale: false, locale: language,
  })));
  const wrapper = mount(MovieDetail, { props: { tmdbId: 42, authenticated: false } });
  mounted.push(wrapper);
  await flushPromises();
  const cards = wrapper.findAll('.person-card');
  expect(cards).toHaveLength(2);
  expect(cards[0]!.get('.person-photo .person-role').text()).toBe(language === 'zh-CN' ? '导演' : 'Director');
  expect(cards[0]!.text()).toContain('Lead');
  expect(cards[0]!.get('.person-original').text()).toBe('Director Actor');
  expect(cards[0]!.get('img').attributes('src')).toBe('https://example.com/director.jpg');
  expect(cards[1]!.find('.person-role').exists()).toBe(false);
  expect(cards[1]!.text()).toContain('Friend / Narrator');
  expect(wrapper.findAll('.people-list')).toHaveLength(1);
  expect(wrapper.findAll('.detail-sections h2')).toHaveLength(0);
  expect(wrapper.find('.detail-action-toolbar > .resource-check-panel').exists()).toBe(false);
});
