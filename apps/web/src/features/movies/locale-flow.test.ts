// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLocale } from '../../i18n';
import MovieBrowser from './MovieBrowser.vue';
import MovieDetail from './MovieDetail.vue';
import { KeepAlive } from 'vue';
import ViewingPreferencesPage from '../viewing-preferences/ViewingPreferencesPage.vue';

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

  it.each(['en-US', 'zh-CN'] as const)('hides poster preferences for guests and restores them after login (%s)', async (locale) => {
    setLocale(locale);
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      items: [{ tmdbId: 42, title: 'Film', userStatus: 'unwatched' }],
      page: 1, hasMore: false, source: 'cache', resultCompleteness: 'complete',
      fetchedAt, generation: trendingGeneration, locale,
    })));
    const wrapper = mount(MovieBrowser, { props: { authenticated: false } });
    try {
      await flushPromises();
      expect(wrapper.find('.movie-card').exists()).toBe(true);
      expect(wrapper.find('.preference-control').exists()).toBe(false);
      await wrapper.setProps({ authenticated: true });
      expect(wrapper.findAll('.preference-button')).toHaveLength(2);
      await wrapper.setProps({ authenticated: false });
      expect(wrapper.findAll('.preference-button')).toHaveLength(0);
    } finally {
      wrapper.unmount();
    }
  });

  it('reloads Trending and Search in the selected locale', async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        urls.push(url);
        const english = url.includes('locale=en-US');
        const searching = url.includes('/movies/search');
        return Response.json(
          searching
            ? {
                items: [
                  { tmdbId: 42, title: english ? 'English search result' : '中文搜索结果', userStatus: 'unwatched' },
                ],
                page: 1,
                hasMore: false,
                source: 'tmdb',
                resultCompleteness: 'complete',
                locale: english ? 'en-US' : 'zh-CN',
              }
            : {
                items: [{ tmdbId: 42, title: english ? 'English trending' : '中文热门', userStatus: 'unwatched' }],
                page: 1,
                hasMore: false,
                source: 'cache',
                resultCompleteness: 'complete',
                fetchedAt,
                generation: trendingGeneration,
                locale: english ? 'en-US' : 'zh-CN',
              }
        );
      })
    );

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

    await wrapper.get('.floating-search-toggle').trigger('click');
    await wrapper.get('input[type="search"]').setValue('galaxy');
    await vi.advanceTimersByTimeAsync(300);
    await flushPromises();
    expect(wrapper.text()).toContain('English search result');
    expect(urls.at(-1)).toContain('/movies/search?query=galaxy&page=1&locale=en-US');
    wrapper.unmount();
  });

  it('invalidates the old pagination before a locale reload can start', async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        urls.push(url);
        const english = url.includes('locale=en-US');
        return Response.json({
          items: [{ tmdbId: 42, title: english ? 'English trending' : '中文热门', userStatus: 'unwatched' }],
          page: 1,
          hasMore: true,
          source: 'cache',
          resultCompleteness: 'complete',
          fetchedAt,
          generation: trendingGeneration,
          locale: english ? 'en-US' : 'zh-CN',
        }
        );
      })
    );

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
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        urls.push(url);
        return new Promise<Response>((resolve) => {
          if (url.includes('locale=en-US')) resolveEnglish = resolve;
          else resolveChinese = resolve;
        });
      })
    );

    const wrapper = mount(MovieBrowser, { props: { authenticated: false } });
    await Promise.resolve();
    setLocale('en-US');
    await vi.advanceTimersByTimeAsync(300);
    expect(urls).toHaveLength(2);

    resolveEnglish(
      Response.json({
        items: [{ tmdbId: 42, title: 'English trending', userStatus: 'unwatched' }],
        page: 1,
        hasMore: false,
        source: 'cache',
        resultCompleteness: 'complete',
        fetchedAt,
        generation: trendingGeneration,
        locale: 'en-US',
      }
      )
    );
    await flushPromises();
    expect(wrapper.text()).toContain('English trending');

    resolveChinese(
      Response.json({
        items: [{ tmdbId: 42, title: 'Late Chinese response', userStatus: 'unwatched' }],
        page: 1,
        hasMore: false,
        source: 'cache',
        resultCompleteness: 'complete',
        fetchedAt,
        generation: trendingGeneration,
        locale: 'zh-CN',
      }
      )
    );
    await flushPromises();
    expect(wrapper.text()).toContain('English trending');
    expect(wrapper.text()).not.toContain('Late Chinese response');
    wrapper.unmount();
  });

  it('does not render a trending movie twice when the next page overlaps', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      return Response.json(
        init?.method === 'POST'
          ? {
              items: [
                { tmdbId: 42, title: '重复电影', userStatus: 'unwatched' },
                { tmdbId: 43, title: '第二页电影', userStatus: 'unwatched' },
              ],
              page: 2,
              hasMore: false,
              source: 'cache',
              resultCompleteness: 'complete',
              fetchedAt,
              generation: trendingGeneration,
              locale: 'zh-CN',
            }
          : {
              items: [{ tmdbId: 42, title: '重复电影', userStatus: 'unwatched' }],
              page: 1,
              hasMore: true,
              source: 'cache',
              resultCompleteness: 'complete',
              fetchedAt,
              generation: trendingGeneration,
              locale: 'zh-CN',
            }
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const wrapper = mount(MovieBrowser, { props: { authenticated: false } });
    await flushPromises();
    await wrapper.get('button.load-more').trigger('click');
    await flushPromises();

    expect(wrapper.findAll('.movie-card')).toHaveLength(2);
    expect(wrapper.findAll('.movie-card').map((card) => card.text())).toEqual([
      expect.stringContaining('重复电影'),
      expect.stringContaining('第二页电影'),
    ]
    );
    const loadMoreRequest = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')?.[1];
    expect(JSON.parse(String(loadMoreRequest?.body))).toMatchObject({
      page: 1,
      generation: trendingGeneration,
      locale: 'zh-CN',
    }
    );
    wrapper.unmount();
  });

  it('does not render a search result twice when the next page overlaps', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (!url.includes('/movies/search')) {
          return Response.json({
            items: [],
            page: 1,
            hasMore: false,
            source: 'cache',
            resultCompleteness: 'complete',
            fetchedAt,
            generation: trendingGeneration,
            locale: 'zh-CN',
          }
          );
        }
        return Response.json(
          url.includes('page=2')
            ? {
                items: [
                  { tmdbId: 42, title: '重复搜索结果', userStatus: 'unwatched' },
                  { tmdbId: 43, title: '新搜索结果', userStatus: 'unwatched' },
                ],
                page: 2,
                hasMore: false,
                source: 'tmdb',
                resultCompleteness: 'complete',
                locale: 'zh-CN',
              }
            : {
                items: [{ tmdbId: 42, title: '重复搜索结果', userStatus: 'unwatched' }],
                page: 1,
                hasMore: true,
                source: 'tmdb',
                resultCompleteness: 'complete',
                locale: 'zh-CN',
              }
        );
      })
    );

    const wrapper = mount(MovieBrowser, { props: { authenticated: false } });
    await flushPromises();
    await wrapper.get('.floating-search-toggle').trigger('click');
    await wrapper.get('input[type="search"]').setValue('galaxy');
    await vi.advanceTimersByTimeAsync(300);
    await flushPromises();
    await wrapper.get('button.load-more').trigger('click');
    await flushPromises();

    expect(wrapper.findAll('.movie-card')).toHaveLength(2);
    expect(wrapper.findAll('.movie-card').map((card) => card.text())).toEqual([
      expect.stringContaining('重复搜索结果'),
      expect.stringContaining('新搜索结果'),
    ]
    );
    wrapper.unmount();
  });

  it('toggles mutually exclusive poster preferences without opening the movie', async () => {
    const requests: Array<{ url: string; method: string; body?: string }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        requests.push({ url, method: init?.method ?? 'GET', ...(init?.body ? { body: String(init.body) } : {}) });
        if (url.endsWith('/preference')) {
          return Response.json({
            tmdbId: 42,
            preference: init?.method === 'DELETE' ? 'neutral' : JSON.parse(String(init?.body)).preference,
          }
          );
        }
        return Response.json({
          items: [{ tmdbId: 42, title: '偏好测试', userStatus: 'watched', userPreference: 'neutral' }],
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

    const wrapper = mount(MovieBrowser, { props: { authenticated: true } });
    await flushPromises();
    expect(wrapper.find('.status-control').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('已看');
    expect(wrapper.text()).not.toContain('想看');
    const buttons = wrapper.findAll('button.preference-button');

    await buttons[0]!.trigger('click');
    await flushPromises();
    expect(buttons[0]!.classes()).toContain('active');
    expect(buttons[1]!.classes()).not.toContain('active');

    await buttons[1]!.trigger('click');
    await flushPromises();
    expect(buttons[0]!.classes()).not.toContain('active');
    expect(buttons[1]!.classes()).toContain('active');

    await buttons[1]!.trigger('click');
    await flushPromises();
    expect(buttons[1]!.classes()).not.toContain('active');
    expect(wrapper.emitted('openMovie')).toBeUndefined();
    expect(requests.filter(({ url }) => url.endsWith('/preference')).map(({ method, body }) => [method, body])).toEqual(
      [
        ['PUT', '{"preference":"liked"}'],
        ['PUT', '{"preference":"disliked"}'],
        ['DELETE', undefined],
      ]
    );
    wrapper.unmount();
  });

  it('reloads Detail without falling back to the other locale', async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        urls.push(url);
        const english = url.includes('locale=en-US');
        return Response.json({
          tmdbId: 42,
          title: english ? 'English detail title' : '中文详情标题',
          overview: english ? 'English story' : '中文剧情',
          tagline: english ? 'English tagline' : '中文宣传语',
          genres: [],
          cast: [],
          directors: [],
          userStatus: 'unwatched',
          detailSyncedAt: fetchedAt,
          stale: false,
          locale: english ? 'en-US' : 'zh-CN',
        }
        );
      })
    );

    const wrapper = mount(MovieDetail, { props: { tmdbId: 42, authenticated: false } });
    await flushPromises();
    expect(wrapper.text()).toContain('中文详情标题');
    expect(wrapper.get('.detail-copy .overview').text()).toBe('中文剧情');
    expect(wrapper.find('.tagline + .overview + .dossier-data').exists()).toBe(true);
    expect(wrapper.find('.detail-sections .overview').exists()).toBe(false);

    setLocale('en-US');
    await flushPromises();
    expect(wrapper.text()).toContain('English detail title');
    expect(wrapper.get('.detail-copy .overview').text()).toBe('English story');
    expect(wrapper.find('.tagline + .overview + .dossier-data').exists()).toBe(true);
    expect(wrapper.text()).not.toContain('中文详情标题');
    expect(urls).toEqual(['/api/v1/movies/42?locale=zh-CN', '/api/v1/movies/42?locale=en-US']);
    wrapper.unmount();
  });

  it('reloads viewing preferences in English while retaining the saved status', async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        urls.push(url);
        const english = url.includes('locale=en-US');
        return Response.json({
          items: [
            {
              tmdbId: 42,
              title: english ? 'Saved English title' : '已保存中文标题',
              userStatus: 'interested',
            },
          ],
          pagination: { page: 1, pageSize: 50, total: 1, hasMore: false },
          locale: english ? 'en-US' : 'zh-CN',
        }
        );
      })
    );

    const wrapper = mount({ components: { KeepAlive, ViewingPreferencesPage }, template: '<KeepAlive><ViewingPreferencesPage /></KeepAlive>' });
    await flushPromises();
    expect(wrapper.text()).toContain('已保存中文标题');

    setLocale('en-US');
    await flushPromises();
    expect(wrapper.text()).toContain('Saved English title');
    expect(wrapper.get('.watchlist-filters').text()).toContain('Watched');
    expect(urls.some((url) => url.includes('status=watched') && url.includes('locale=en-US'))).toBe(true);
    expect(urls.every((url) => !url.includes('/sync') && !url.includes('integration-preferences'))).toBe(true);
    wrapper.unmount();
  });
});
