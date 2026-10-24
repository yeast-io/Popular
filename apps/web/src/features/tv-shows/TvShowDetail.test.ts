// @vitest-environment happy-dom
import { mount, flushPromises } from '@vue/test-utils';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import TvShowDetail from './TvShowDetail.vue';
import { setLocale } from '../../i18n';

const seasonSummary = (number: number) => ({ tmdbId: 90 + number, tvShowTmdbId: 42, seasonNumber: number, name: `Season ${number}`, episodeCount: 1 });
const episode = (seasonNumber: number) => ({ tmdbId: 100 + seasonNumber, tvShowTmdbId: 42, seasonNumber, episodeNumber: 1,
  name: `Episode ${seasonNumber}`, overview: 'The full episode overview.', stillUrl: 'https://image.tmdb.org/t/p/w500/still.jpg', runtimeMinutes: 45, voteAverage: 8, voteCount: 2 });
const detail = { mediaType: 'tv', tmdbId: 42, name: 'Series', overview: 'Series overview', status: 'Returning Series', numberOfSeasons: 2, firstAirDate: '2021-04-30', voteAverage: 8.25, voteCount: 10,
  seasons: [seasonSummary(0), seasonSummary(2), seasonSummary(1)], genres: [], stale: false, locale: 'en-US', detailSyncedAt: new Date().toISOString() };
const seasonDetail = (number: number) => ({ ...seasonSummary(number), episodes: [episode(number)], stale: false, locale: 'en-US', detailSyncedAt: new Date().toISOString() });
const mounted: ReturnType<typeof mount>[] = [];
const render = () => {
  const wrapper = mount(TvShowDetail, { props: { tmdbId: 42 }, attachTo: document.body });
  mounted.push(wrapper);
  return wrapper;
};
beforeEach(() => {
  setLocale('en-US');
  vi.spyOn(HTMLDialogElement.prototype, 'showModal').mockImplementation(function (this: HTMLDialogElement) {
    this.open = true;
  });
  vi.spyOn(HTMLDialogElement.prototype, 'close').mockImplementation(function (this: HTMLDialogElement) {
    this.open = false;
  });
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const number = url.match(/seasons\/(\d+)/)?.[1];
    return Response.json(number === undefined ? detail : seasonDetail(Number(number)));
  }));
});
afterEach(() => {
  mounted.splice(0).forEach((wrapper) => wrapper.unmount());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});
describe('TV detail flow', () => {
  it('defaults to season 1, puts specials last, opens full episode dialog and restores focus', async () => {
    const wrapper = render();
    await flushPromises();
    expect(wrapper.get('[role=combobox]').text()).toContain('Season 1');
    await wrapper.get('[role=combobox]').trigger('click');
    expect(wrapper.findAll('[role=option]').map((option) => option.attributes('data-season'))).toEqual(['1', '2', '0']);
    await wrapper.get('[role=combobox]').trigger('keydown', { key: 'Escape' });
    const trigger = wrapper.get<HTMLButtonElement>('.tv-episode-card');
    trigger.element.focus();
    await trigger.trigger('click');
    await flushPromises();
    const dialog = document.querySelector('dialog')!;
    expect(dialog.open).toBe(true);
    expect(dialog.textContent).toContain('The full episode overview.');
    expect(dialog.textContent).toContain('45 min');
    expect(document.body.style.overflow).toBe('hidden');
    dialog.dispatchEvent(new Event('cancel', { cancelable: true }));
    await flushPromises();
    expect(document.querySelector('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger.element);
    expect(document.body.style.overflow).toBe('');
  });
  it('ignores a late response from a previously selected season even if fetch ignores abort', async () => {
    const pending = new Map<number, (response: Response) => void>();
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const number = String(input).match(/seasons\/(\d+)/)?.[1];
      return number === undefined ? Promise.resolve(Response.json(detail)) : new Promise<Response>((resolve) => pending.set(Number(number), resolve));
    }));
    const wrapper = render();
    await flushPromises();
    await wrapper.get('[role=combobox]').trigger('click');
    await wrapper.get('[data-season="2"]').trigger('click');
    pending.get(2)!(Response.json(seasonDetail(2)));
    await flushPromises();
    pending.get(1)!(Response.json(seasonDetail(1)));
    await flushPromises();
    expect(wrapper.text()).toContain('Episode 2');
    expect(wrapper.get('.tv-episode-copy strong').text()).toBe('Episode 2');
  });
  it('switching locale reloads show and episodes and closes the previous episode dialog', async () => {
    const wrapper = render();
    await flushPromises();
    await wrapper.get('.tv-episode-card').trigger('click');
    expect(document.querySelector('dialog')).not.toBeNull();
    setLocale('zh-CN');
    await flushPromises();
    expect(document.querySelector('dialog')).toBeNull();
    expect(wrapper.text()).not.toContain('选择季');
    expect(wrapper.get('[role=combobox]').attributes('aria-label')).toBe('选择季');
    expect(wrapper.text()).toContain('待续');
    expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input).includes('/seasons/1?locale=zh-CN'))).toBe(true);
  });
  it('handles no seasons, specials-only, unknown counts, missing images and empty episodes', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...detail, seasons: [] })));
    const wrapper = render();
    await flushPromises();
    expect(wrapper.text()).toContain('No season information');
    expect(wrapper.find('[role=combobox]').exists()).toBe(false);
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => Response.json(String(input).includes('/seasons/')
      ? { ...seasonDetail(0), episodes: [] }
      : { ...detail, seasons: [{ ...seasonSummary(0), episodeCount: undefined }] })));
    await wrapper.setProps({ tmdbId: 43 });
    await flushPromises();
    expect(wrapper.get('[role=combobox]').text()).toContain('Specials');
    expect(wrapper.text()).toContain('Episode count unknown');
    expect(wrapper.text()).toContain('No episode information');
    expect(wrapper.text()).toContain('Image unavailable');
  });
  it('season failure supports retry without replacing the selected season', async () => {
    let fail = true;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (!String(input).includes('/seasons/'))
        return Response.json(detail);
      return fail ? new Response('{}', { status: 503 }) : Response.json(seasonDetail(1));
    }));
    const wrapper = render();
    await flushPromises();
    expect(wrapper.find('[role="alert"]').exists()).toBe(true);
    fail = false;
    await wrapper.get('[role="alert"] button').trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('Episode 1');
    expect(wrapper.get('[role=combobox]').text()).toContain('Season 1');
  });
});

it('adds and removes TV watch list membership from details, with session credentials', async () => {
  let saved = false;
  const fetcher = vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
    const url = String(input);
    if (url.includes('/me/watchlist/')) {
      if (options?.method === 'PUT') saved = true;
      if (options?.method === 'DELETE') saved = false;
      return Response.json({ inWatchlist: saved });
    }
    const number = url.match(/seasons\/(\d+)/)?.[1];
    return Response.json(number === undefined ? detail : seasonDetail(Number(number)));
  });
  vi.stubGlobal('fetch', fetcher);
  const wrapper = mount(TvShowDetail, { props: { tmdbId: 42, authenticated: true } });
  mounted.push(wrapper);
  await flushPromises();
  expect(wrapper.get('.tv-watchlist-button').attributes('aria-label')).toBe('Add to watch list');
  expect(wrapper.find('.tv-watchlist-button svg').exists()).toBe(true);
  expect(wrapper.get('.tv-watchlist-button [role=tooltip]').text()).toBe('Not in watch list');
  await wrapper.get('.tv-watchlist-button').trigger('click');
  await flushPromises();
  expect(saved).toBe(true);
  expect(wrapper.get('.tv-watchlist-button').attributes('aria-pressed')).toBe('true');
  expect(wrapper.get('.tv-watchlist-button [role=tooltip]').text()).toBe('In watch list');
  await wrapper.get('.tv-watchlist-button').trigger('click');
  await flushPromises();
  expect(saved).toBe(false);
  expect(fetcher.mock.calls.filter(([input]) => String(input).includes('/me/watchlist/')).every(([, options]) => options?.credentials === 'include')).toBe(true);
});

it('requests login before saving a TV watch list entry', async () => {
  const wrapper = render();
  await flushPromises();
  await wrapper.get('.tv-watchlist-button').trigger('click');
  expect(wrapper.emitted('requireLogin')).toEqual([[]]);
});

it.each(['en-US', 'zh-CN'] as const)('uses movie detail fact and story formatting with numeric season count (%s)', async (language) => {
  setLocale(language);
  const wrapper = render();
  await flushPromises();
  const facts = wrapper.get('.dossier-data');
  expect(facts.findAll('dt').map((item) => item.text())).toEqual(language === 'zh-CN' ? ['首播日期', '评分', '播出状态', '季数'] : ['First aired', 'Rating', 'Status', 'Seasons']);
  expect(facts.findAll('dd').map((item) => item.text())).toEqual(language === 'zh-CN' ? ['2021年4月30日', '8.3', '待续', '2'] : ['April 30, 2021', '8.3', 'Returning series', '2']);
  expect(wrapper.get('.detail-copy .overview').text()).toBe('Series overview');
  expect(wrapper.find('.tv-detail-sections').exists()).toBe(false);
  expect(wrapper.get('.overview').element.compareDocumentPosition(wrapper.get('.dossier-data').element) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

it('places trailer playback before the watch list icon and opens the returned TV video', async () => {
  const trailer = { tmdbVideoId: 'video', provider: 'youtube', providerVideoId: 'Safe_video-1', name: 'Official trailer', official: true };
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => Response.json(String(input).includes('/seasons/') ? seasonDetail(1) : { ...detail, trailer })));
  const wrapper = mount(TvShowDetail, { props: { tmdbId: 42 }, global: { stubs: { MediaTrailerDialog: true } } });
  mounted.push(wrapper);
  await flushPromises();
  expect(wrapper.get('.tv-media-actions').findAll('button').map((button) => button.classes()[0])).toEqual(['trailer-button', 'detail-state-icon']);
  await wrapper.get('.trailer-button').trigger('click');
  await flushPromises();
  const player = wrapper.findComponent({ name: 'MediaTrailerDialog' });
  expect(player.props('trailer')).toEqual(trailer);
  expect(player.props('title')).toBe('Series');
});

it.each(['en-US', 'zh-CN'] as const)('shows the localized tagline before overview, hiding missing or blank text (%s)', async (language) => {
  setLocale(language);
  const tagline = language === 'zh-CN' ? '真相即将揭晓' : 'The truth awaits';
  let value: string | undefined = tagline;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => Response.json(String(input).includes('/seasons/') ? seasonDetail(1) : { ...detail, tagline: value })));
  const wrapper = render();
  await flushPromises();
  expect(wrapper.get('.tagline').text()).toBe(`“${tagline}”`);
  expect(wrapper.find('.tagline + .overview + .dossier-data').exists()).toBe(true);
  for (const empty of [undefined, '', '   ']) {
    value = empty;
    await wrapper.setProps({ tmdbId: wrapper.props('tmdbId') + 1 });
    await flushPromises();
    expect(wrapper.find('.tagline').exists()).toBe(false);
    expect(wrapper.get('.overview').text()).toBe('Series overview');
  }
});
