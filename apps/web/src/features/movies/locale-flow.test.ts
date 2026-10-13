// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLocale } from '../../i18n';
import MovieBrowser from './MovieBrowser.vue';
import MovieDetail from './MovieDetail.vue';
import MyMovies from './MyMovies.vue';

const fetchedAt = '2026-10-12T00:00:00.000Z';
const trendingGeneration = '00000000-0000-4000-8000-000000000001';

describe('localized movie page flows', () => {
  beforeEach(() => {
    setLocale('zh-CN');
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('reloads Trending and Search in the selected locale', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      const english = url.includes('locale=en-US');
      const searching = url.includes('/movies/search');
      return Response.json(searching ? {
        items: [{ tmdbId: 42, title: english ? 'English search result' : '中文搜索结果', userStatus: 'unwatched' }],
        page: 1, hasMore: false, source: 'tmdb', resultCompleteness: 'complete', locale: english ? 'en-US' : 'zh-CN',
      } : {
        items: [{ tmdbId: 42, title: english ? 'English trending' : '中文热门', userStatus: 'unwatched' }],
        page: 1, hasMore: false, source: 'cache', resultCompleteness: 'complete', fetchedAt,
        generation: trendingGeneration,
        locale: english ? 'en-US' : 'zh-CN',
      });
    }));

    const wrapper = mount(MovieBrowser, { props: { authenticated: false } });
    await flushPromises();
    expect(wrapper.text()).toContain('中文热门');
    expect(urls.at(-1)).toContain('locale=zh-CN');

    setLocale('en-US');
    await vi.advanceTimersByTimeAsync(300);
    await flushPromises();
    expect(wrapper.text()).toContain('English trending');
    expect(wrapper.get('input[type="search"]').attributes('placeholder')).toBe('Search movies…');
    expect(urls.at(-1)).toContain('locale=en-US');

    await wrapper.get('input[type="search"]').setValue('galaxy');
    await vi.advanceTimersByTimeAsync(300);
    await flushPromises();
    expect(wrapper.text()).toContain('English search result');
    expect(urls.at(-1)).toContain('/movies/search?query=galaxy&page=1&locale=en-US');
    wrapper.unmount();
  });

  it('invalidates the old pagination before a locale reload can start', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      const english = url.includes('locale=en-US');
      return Response.json({
        items: [{ tmdbId: 42, title: english ? 'English trending' : '中文热门', userStatus: 'unwatched' }],
        page: 1, hasMore: true, source: 'cache', resultCompleteness: 'complete', fetchedAt,
        generation: trendingGeneration,
        locale: english ? 'en-US' : 'zh-CN',
      });
    }));

    const wrapper = mount(MovieBrowser, { props: { authenticated: false } });
    await flushPromises();
    const oldLoadMoreButton = wrapper.get('button.load-more');

    setLocale('en-US');
    await oldLoadMoreButton.trigger('click');
    await flushPromises();

    expect(urls.some((url) => url.includes('/movies/trending/load-more'))).toBe(false);
    expect(wrapper.find('button.load-more').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('中文热门');

    await vi.advanceTimersByTimeAsync(300);
    await flushPromises();
    expect(wrapper.text()).toContain('English trending');
    wrapper.unmount();
  });

  it('does not let an old locale response overwrite the current locale', async () => {
    let resolveChinese!: (response: Response) => void;
    let resolveEnglish!: (response: Response) => void;
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      return new Promise<Response>((resolve) => {
        if (url.includes('locale=en-US')) resolveEnglish = resolve;
        else resolveChinese = resolve;
      });
    }));

    const wrapper = mount(MovieBrowser, { props: { authenticated: false } });
    await Promise.resolve();
    setLocale('en-US');
    await vi.advanceTimersByTimeAsync(300);
    expect(urls).toHaveLength(2);

    resolveEnglish(Response.json({
      items: [{ tmdbId: 42, title: 'English trending', userStatus: 'unwatched' }],
      page: 1, hasMore: false, source: 'cache', resultCompleteness: 'complete', fetchedAt,
      generation: trendingGeneration, locale: 'en-US',
    }));
    await flushPromises();
    expect(wrapper.text()).toContain('English trending');

    resolveChinese(Response.json({
      items: [{ tmdbId: 42, title: 'Late Chinese response', userStatus: 'unwatched' }],
      page: 1, hasMore: false, source: 'cache', resultCompleteness: 'complete', fetchedAt,
      generation: trendingGeneration, locale: 'zh-CN',
    }));
    await flushPromises();
    expect(wrapper.text()).toContain('English trending');
    expect(wrapper.text()).not.toContain('Late Chinese response');
    wrapper.unmount();
  });

  it('does not render a trending movie twice when the next page overlaps', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => Response.json(
      init?.method === 'POST'
        ? {
            items: [
              { tmdbId: 42, title: '重复电影', userStatus: 'unwatched' },
              { tmdbId: 43, title: '第二页电影', userStatus: 'unwatched' },
            ],
            page: 2, hasMore: false, source: 'cache', resultCompleteness: 'complete', fetchedAt,
            generation: trendingGeneration, locale: 'zh-CN',
          }
        : {
            items: [{ tmdbId: 42, title: '重复电影', userStatus: 'unwatched' }],
            page: 1, hasMore: true, source: 'cache', resultCompleteness: 'complete', fetchedAt,
            generation: trendingGeneration, locale: 'zh-CN',
          },
    ));
    vi.stubGlobal('fetch', fetchMock);

    const wrapper = mount(MovieBrowser, { props: { authenticated: false } });
    await flushPromises();
    await wrapper.get('button.load-more').trigger('click');
    await flushPromises();

    expect(wrapper.findAll('.movie-card')).toHaveLength(2);
    expect(wrapper.findAll('.movie-card').map((card) => card.text())).toEqual([
      expect.stringContaining('重复电影'),
      expect.stringContaining('第二页电影'),
    ]);
    const loadMoreRequest = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')?.[1];
    expect(JSON.parse(String(loadMoreRequest?.body))).toMatchObject({ page: 1, generation: trendingGeneration, locale: 'zh-CN' });
    wrapper.unmount();
  });

  it('does not render a search result twice when the next page overlaps', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (!url.includes('/movies/search')) {
        return Response.json({
          items: [], page: 1, hasMore: false, source: 'cache', resultCompleteness: 'complete', fetchedAt,
          generation: trendingGeneration, locale: 'zh-CN',
        });
      }
      return Response.json(url.includes('page=2')
        ? {
            items: [
              { tmdbId: 42, title: '重复搜索结果', userStatus: 'unwatched' },
              { tmdbId: 43, title: '新搜索结果', userStatus: 'unwatched' },
            ],
            page: 2, hasMore: false, source: 'tmdb', resultCompleteness: 'complete', locale: 'zh-CN',
          }
        : {
            items: [{ tmdbId: 42, title: '重复搜索结果', userStatus: 'unwatched' }],
            page: 1, hasMore: true, source: 'tmdb', resultCompleteness: 'complete', locale: 'zh-CN',
          });
    }));

    const wrapper = mount(MovieBrowser, { props: { authenticated: false } });
    await flushPromises();
    await wrapper.get('input[type="search"]').setValue('galaxy');
    await vi.advanceTimersByTimeAsync(300);
    await flushPromises();
    await wrapper.get('button.load-more').trigger('click');
    await flushPromises();

    expect(wrapper.findAll('.movie-card')).toHaveLength(2);
    expect(wrapper.findAll('.movie-card').map((card) => card.text())).toEqual([
      expect.stringContaining('重复搜索结果'),
      expect.stringContaining('新搜索结果'),
    ]);
    wrapper.unmount();
  });

  it('reloads Detail without falling back to the other locale', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      const english = url.includes('locale=en-US');
      return Response.json({
        tmdbId: 42,
        title: english ? 'English detail title' : '中文详情标题',
        overview: english ? 'English story' : '中文剧情',
        genres: [], cast: [], directors: [], userStatus: 'unwatched', detailSyncedAt: fetchedAt,
        stale: false, locale: english ? 'en-US' : 'zh-CN',
      });
    }));

    const wrapper = mount(MovieDetail, { props: { tmdbId: 42, authenticated: false } });
    await flushPromises();
    expect(wrapper.text()).toContain('中文详情标题');

    setLocale('en-US');
    await flushPromises();
    expect(wrapper.text()).toContain('English detail title');
    expect(wrapper.text()).not.toContain('中文详情标题');
    expect(urls).toEqual([
      '/api/v1/movies/42?locale=zh-CN',
      '/api/v1/movies/42?locale=en-US',
    ]);
    wrapper.unmount();
  });

  it('reloads My Movies in English while retaining the saved status', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      const english = url.includes('locale=en-US');
      return Response.json({
        items: [{
          tmdbId: 42,
          title: english ? 'Saved English title' : '已保存中文标题',
          userStatus: 'interested',
        }],
        pagination: { page: 1, pageSize: 50, total: 1, hasMore: false },
        locale: english ? 'en-US' : 'zh-CN',
      });
    }));

    const wrapper = mount(MyMovies);
    await flushPromises();
    expect(wrapper.text()).toContain('已保存中文标题');

    setLocale('en-US');
    await flushPromises();
    expect(wrapper.text()).toContain('Saved English title');
    expect(wrapper.text()).toContain('Interested');
    expect(urls).toEqual([
      '/api/v1/me/movies?status=interested&page=1&pageSize=50&locale=zh-CN',
      '/api/v1/me/integrations/mteam',
      '/api/v1/me/movies?status=interested&page=1&pageSize=50&locale=en-US',
    ]);
    wrapper.unmount();
  });
});
