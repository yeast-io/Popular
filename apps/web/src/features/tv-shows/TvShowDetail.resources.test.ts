// @vitest-environment happy-dom
import { mount, flushPromises } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TvShowDetail from './TvShowDetail.vue';
import { setLocale } from '../../i18n';

const detail = { mediaType: 'tv', tmdbId: 42, name: '黑帮领地', originalName: 'MobLand', overview: '',
  genres: [], seasons: [1, 2].map((number) => ({ tmdbId: number, tvShowTmdbId: 42, seasonNumber: number, name: `Season ${number}`, episodeCount: 10 })),
  stale: false, locale: 'en-US', detailSyncedAt: new Date().toISOString() };
const mounted: ReturnType<typeof mount>[] = [];
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
    if (url.includes('integration-preferences')) return Response.json({ defaults: {}, choices: [], selectedSites: [], effectiveSites: [] });
    if (url.includes('/watchlist/')) return Response.json({ inWatchlist: false });
    if (url.includes('/seasons/')) return Response.json({ ...detail.seasons[0], episodes: [], stale: false });
    return Response.json(detail);
  }));
});
afterEach(() => {
  mounted.splice(0).forEach((wrapper) => wrapper.unmount());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});
describe('TV season resources', () => {
  it.each(['en-US', 'zh-CN'] as const)('queries enabled sites on demand, then opens saved results in %s', async (locale) => {
    setLocale(locale);
    const base = globalThis.fetch;
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('integration-preferences')) return Response.json({ defaults: { resource: 'mteam' }, choices: [], selectedSites: [], effectiveSites: ['mteam'] });
      if (url.includes('resource-search')) return Response.json({ releases: [{ id: '1', title: 'MobLand S02' }] });
      return base(input, init);
    });
    vi.stubGlobal('fetch', fetcher);
    const wrapper = mount(TvShowDetail, { props: { tmdbId: 42, authenticated: true }, attachTo: document.body });
    mounted.push(wrapper);
    await flushPromises();
    expect(fetcher.mock.calls.some(([url]) => String(url).includes('resource-search') || String(url).includes('integration-preferences'))).toBe(false);
    expect(wrapper.get('.detail-poster .poster-resource-badge').classes()).toContain('is-pending');
    await wrapper.get('[role=combobox]').trigger('click');
    await wrapper.get('[data-season="2"]').trigger('click');
    await flushPromises();
    await wrapper.get('.tv-resource-query-button').trigger('click');
    await flushPromises();
    expect(document.querySelector('dialog')).toBeNull();
    expect(wrapper.get('.tv-resource-query-button').text()).toBe(locale === 'en-US' ? 'Available' : '有资源');
    expect(wrapper.get('.tv-resource-query-button').attributes('title')).toBe(locale === 'en-US' ? 'View resources' : '查看资源');
    expect(wrapper.get('.dossier-data > div:last-child').classes()).toContain('dossier-resource');
    expect(wrapper.find('.resource-check-panel').exists()).toBe(false);
    expect(wrapper.get('.detail-poster .poster-resource-badge').classes()).toContain('is-available');
    const queries = fetcher.mock.calls.filter(([url]) => String(url).includes('resource-search'));
    expect(queries).toHaveLength(1);
    expect(new URL(String(queries[0]![0]), 'http://localhost').searchParams.get('query')).toBe('MobLand S02');
    expect(String(queries[0]![0])).toContain('mediaType=tv');
    await wrapper.get('.detail-poster .poster-resource-badge').trigger('click');
    await flushPromises();
    expect(document.querySelector('dialog')?.textContent).toContain('MobLand S02');
    expect(fetcher.mock.calls.filter(([url]) => String(url).includes('resource-search'))).toHaveLength(1);
    await wrapper.setProps({ authenticated: false });
    await flushPromises();
    expect(document.querySelector('dialog')).toBeNull();
    expect(wrapper.find('.poster-resource-badge').exists()).toBe(false);
  });

  it('hides resource controls and sends no resource query for guests', async () => {
    const wrapper = mount(TvShowDetail, { props: { tmdbId: 42, authenticated: false } });
    mounted.push(wrapper);
    await flushPromises();
    expect(wrapper.find('.tv-resource-query-button').exists()).toBe(false);
    expect(wrapper.find('.poster-resource-badge').exists()).toBe(false);
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes('integration-preferences'))).toBe(false);
  });

  it('cancels a season query and ignores results arriving after the season changes', async () => {
    const base = globalThis.fetch;
    let finish!: (response: Response) => void;
    let signal: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('integration-preferences')) return Response.json({ defaults: { resource: 'mteam' }, choices: [], selectedSites: [], effectiveSites: ['mteam'] });
      if (url.includes('resource-search')) {
        signal = init?.signal ?? undefined;
        return new Promise<Response>((resolve) => {
          finish = resolve;
        });
      }
      return base(input, init);
    }));
    const wrapper = mount(TvShowDetail, { props: { tmdbId: 42, authenticated: true } });
    mounted.push(wrapper);
    await flushPromises();
    await wrapper.get('.tv-resource-query-button').trigger('click');
    await flushPromises();
    expect(wrapper.get('.detail-poster .poster-resource-badge').classes()).toContain('is-checking');
    await wrapper.get('[role=combobox]').trigger('click');
    await wrapper.get('[data-season="2"]').trigger('click');
    await flushPromises();
    expect(signal?.aborted).toBe(true);
    finish(Response.json({ releases: [{ id: 'old', title: 'MobLand S01' }] }));
    await flushPromises();
    expect(wrapper.get('.detail-poster .poster-resource-badge').classes()).toContain('is-pending');
    expect(document.querySelector('dialog')).toBeNull();
  });

  it('keeps available results when another enabled site fails and clears them when settings change', async () => {
    const base = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('integration-preferences')) return Response.json({ defaults: { resource: 'mteam' }, choices: [], selectedSites: [], effectiveSites: ['mteam', 'hdarea'] });
      if (url.includes('/hdarea/releases')) return Response.json({ error: { code: 'RESOURCE_SITE_FAILED', details: { reason: 'timeout' } } }, { status: 504 });
      if (url.includes('/mteam/releases')) return Response.json({ releases: [{ id: '1', title: 'MobLand S01' }] });
      return base(input, init);
    }));
    const wrapper = mount(TvShowDetail, { props: { tmdbId: 42, authenticated: true }, attachTo: document.body });
    mounted.push(wrapper);
    await flushPromises();
    await wrapper.get('.tv-resource-query-button').trigger('click');
    await flushPromises();
    expect(wrapper.get('.dossier-resource-button').text()).toContain('Results incomplete');
    await wrapper.get('.tv-resource-query-button').trigger('click');
    await flushPromises();
    expect(document.querySelector('dialog')?.textContent).toContain('MobLand S01');
    window.dispatchEvent(new Event('integration-preferences-changed'));
    await flushPromises();
    expect(document.querySelector('dialog')).toBeNull();
    expect(wrapper.get('.detail-poster .poster-resource-badge').classes()).toContain('is-pending');
  });
});
