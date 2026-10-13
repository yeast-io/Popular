import assert from 'node:assert/strict';
import test from 'node:test';
import type { MovieRecord, MovieStatusRecord, TrendingPageRecord, TrendingSnapshotRecord, TrendingStore } from './movie.types.js';
import { MovieService } from './movie.service.js';

const generation = '00000000-0000-4000-8000-000000000001';

class MemoryTrendingStore implements TrendingStore {
  readonly pages = new Map<string, TrendingPageRecord>();
  async publishSnapshot(record: TrendingSnapshotRecord, locale: 'zh-CN' | 'en-US') {
    for (const page of record.pages) this.pages.set(`${locale}:${page.page}`, page);
  }
  async appendSnapshotPage(record: TrendingPageRecord, locale: 'zh-CN' | 'en-US') { this.pages.set(`${locale}:${record.page}`, record); }
  async readPage(page: number, locale: 'zh-CN' | 'en-US', requestedGeneration?: string) {
    const record = this.pages.get(`${locale}:${page}`);
    if (!record || (requestedGeneration && requestedGeneration !== generation)) return null;
    return { ...record, generation };
  }
  async readSnapshot(locale: 'zh-CN' | 'en-US', requestedGeneration: string) {
    if (requestedGeneration !== generation) return null;
    const pages = [...this.pages.entries()]
      .filter(([key]) => key.startsWith(`${locale}:`))
      .map(([, page]) => page)
      .sort((left, right) => left.page - right.page);
    if (!pages.length) return null;
    return { generation, pages, sourcePage: pages.length, pageSize: pages[0]!.movies.length, fetchedAt: pages[0]!.fetchedAt };
  }
}

const fetchedAt = new Date('2026-10-12T00:00:00.000Z');

test('trending preserves source order and maps optional presentation fields', async () => {
  const store = new MemoryTrendingStore();
  store.pages.set('zh-CN:1', {
    page: 1, totalPages: 2, totalResults: 2, fetchedAt,
    movies: [
      { tmdbId: 20, title: '第二十部', originalTitle: 'Twenty', releaseDate: '2026-10-10', posterPath: '/poster.jpg', genreIds: [], voteAverage: 8.25 },
      { tmdbId: 3, title: '第三部', genreIds: [] },
    ],
  });
  const sync = { syncPage: async () => ({ status: 'completed' as const, pages: 1, movies: 0 }) };
  const service = new MovieService(store, sync as never);

  const result = await service.trending(1, 'zh-CN', null);
  assert.deepEqual(result.items.map(({ tmdbId }) => tmdbId), [20, 3]);
  assert.equal(result.items[0]?.posterUrl, 'https://image.tmdb.org/t/p/w500/poster.jpg');
  assert.equal(result.items[1]?.posterUrl, undefined);
  assert.equal(result.items[0]?.userStatus, 'unwatched');
  assert.equal(result.hasMore, true);
  assert.equal(result.generation, generation);
  assert.equal(result.locale, 'zh-CN');
});

test('trending lazily syncs the requested locale when its page is missing', async () => {
  const store = new MemoryTrendingStore();
  let requestedLocale = '';
  const sync = { syncPage: async (page: number, _trigger: string, locale: 'zh-CN' | 'en-US') => {
    requestedLocale = locale;
    await store.publishSnapshot({
      generation, sourcePage: page, pageSize: 1, fetchedAt,
      pages: [{ page, totalPages: 1, totalResults: 1, fetchedAt, movies: [{ tmdbId: 1, title: 'Movie', genreIds: [] }] }],
    }, locale);
    return { status: 'completed' as const, pages: 1, movies: 1 };
  } };
  const result = await new MovieService(store, sync as never).trending(1, 'en-US', null);
  assert.equal(requestedLocale, 'en-US');
  assert.equal(result.locale, 'en-US');
});

test('trending reports a stable error when sync completes without publishing a page', async () => {
  const sync = { syncPage: async () => ({ status: 'completed' as const, pages: 1, movies: 0 }) };
  const service = new MovieService(new MemoryTrendingStore(), sync as never);
  await assert.rejects(() => service.trending(1, 'zh-CN', null), { statusCode: 503, code: 'TRENDING_NOT_SYNCED' });
});

test('trending does not let a direct request lazily sync an arbitrary later page', async () => {
  let called = false;
  const sync = { syncPage: async () => {
    called = true;
    return { status: 'completed' as const, pages: 1, movies: 0 };
  } };
  const service = new MovieService(new MemoryTrendingStore(), sync as never);

  await assert.rejects(() => service.trending(37, 'en-US', null), { statusCode: 503, code: 'TRENDING_NOT_SYNCED' });
  assert.equal(called, false);
});

test('load more syncs only the next missing page', async () => {
  const store = new MemoryTrendingStore();
  store.pages.set('en-US:1', { page: 1, totalPages: 2, totalResults: 1, fetchedAt, movies: [{ tmdbId: 7, title: 'First', genreIds: [] }] });
  let requestedPage = 0;
  const sync = {
    syncPage: async (page: number, _trigger: string, locale: string, requestedGeneration: string) => {
      assert.equal(locale, 'en-US');
      assert.equal(requestedGeneration, generation);
      requestedPage = page;
      store.pages.set(`${locale}:${page}`, { page, totalPages: 2, totalResults: 1, fetchedAt, movies: [{ tmdbId: 8, title: 'Next', genreIds: [] }] });
      return { status: 'completed' as const, pages: 1, movies: 1 };
    },
  };
  const result = await new MovieService(store, sync as never).loadMore(1, generation, 'en-US', null);
  assert.equal(requestedPage, 2);
  assert.equal(result.page, 2);
});

test('load more rejects a fabricated current page instead of allowing arbitrary TMDB fetches', async () => {
  let called = false;
  const sync = { syncPage: async () => { called = true; return { status: 'completed' as const, pages: 1, movies: 0 }; } };
  const service = new MovieService(new MemoryTrendingStore(), sync as never);
  await assert.rejects(() => service.loadMore(37, generation, 'zh-CN', null), { statusCode: 400, code: 'BAD_REQUEST' });
  assert.equal(called, false);
});

test('search caches results and merges statuses for the authenticated owner', async () => {
  const store = new MemoryTrendingStore();
  let cached: MovieRecord[] = [];
  const catalog = {
    upsertMovies: async (movies: MovieRecord[]) => { cached = movies; },
    publishSearch: async (_query: string, record: TrendingPageRecord) => { cached = record.movies; },
    readSearch: async () => null,
    readMovies: async () => [],
    hasMovie: async () => false,
    writeMovieDetail: async () => undefined,
    readMovieDetail: async () => null,
  };
  const provider = { search: async () => ({
    page: 1, totalPages: 2, totalResults: 1,
    movies: [{ tmdbId: 42, title: '银河', originalTitle: 'Galaxy', genreIds: [] }],
  }), fetchDetails: async () => { throw new Error('not used'); } };
  const statuses = {
    readForMovies: async (ownerId: string): Promise<MovieStatusRecord[]> => {
      assert.equal(ownerId, 'owner-1');
      return [{ tmdbId: 42, status: 'interested', updatedAt: fetchedAt }];
    },
  };
  const service = new MovieService(store, {} as never, provider, catalog, statuses as never);

  const result = await service.search(' 银河 ', 1, 'en-US', 'owner-1');

  assert.equal(cached[0]?.tmdbId, 42);
  assert.equal(result.items[0]?.userStatus, 'interested');
  assert.equal(result.hasMore, true);
  assert.equal(result.locale, 'en-US');
  assert.equal(result.source, 'tmdb');
  assert.equal(result.resultCompleteness, 'complete');
});

test('search uses only a fresh summary cache for the requested locale', async () => {
  const store = new MemoryTrendingStore();
  let providerCalls = 0;
  const catalog = {
    upsertMovies: async () => undefined,
    publishSearch: async () => undefined,
    readSearch: async () => ({
      page: 1, totalPages: 1, totalResults: 1, fetchedAt: new Date(),
      movies: [{
        tmdbId: 42, title: 'Cached title', genreIds: [], localizationLocale: 'en-US' as const,
        summarySyncedAt: new Date(),
      }],
    }),
    readMovies: async () => [], hasMovie: async () => true,
    writeMovieDetail: async () => undefined, readMovieDetail: async () => null,
  };
  const provider = {
    search: async () => { providerCalls += 1; throw new Error('must not fetch'); },
    fetchDetails: async () => { throw new Error('not used'); },
  };

  const result = await new MovieService(store, {} as never, provider, catalog).search('movie', 1, 'en-US', null);
  assert.equal(providerCalls, 0);
  assert.equal(result.items[0]?.title, 'Cached title');
  assert.equal(result.source, 'cache');
});

test('search refreshes a summary cache that belongs to another locale', async () => {
  const store = new MemoryTrendingStore();
  let providerCalls = 0;
  const catalog = {
    upsertMovies: async () => undefined,
    publishSearch: async () => undefined,
    readSearch: async () => ({
      page: 1, totalPages: 1, totalResults: 1, fetchedAt: new Date(),
      movies: [{
        tmdbId: 42, title: 'Fallback title', genreIds: [], localizationLocale: 'zh-CN' as const,
        summarySyncedAt: new Date(),
      }],
    }),
    readMovies: async () => [], hasMovie: async () => true,
    writeMovieDetail: async () => undefined, readMovieDetail: async () => null,
  };
  const provider = {
    search: async () => {
      providerCalls += 1;
      return { page: 1, totalPages: 1, totalResults: 1, movies: [{ tmdbId: 42, title: 'English title', genreIds: [] }] };
    },
    fetchDetails: async () => { throw new Error('not used'); },
  };

  const result = await new MovieService(store, {} as never, provider, catalog).search('movie', 1, 'en-US', null);
  assert.equal(providerCalls, 1);
  assert.equal(result.items[0]?.title, 'English title');
  assert.equal(result.source, 'tmdb');
});

test('search falls back only to a stale cache in the requested locale', async () => {
  const store = new MemoryTrendingStore();
  const staleEnglish = {
    page: 1, totalPages: 1, totalResults: 1, fetchedAt,
    movies: [{
      tmdbId: 42, title: 'Old English title', genreIds: [], localizationLocale: 'en-US' as const,
      summarySyncedAt: new Date(0),
    }],
  };
  const provider = {
    search: async () => { throw new Error('TMDB unavailable'); },
    fetchDetails: async () => { throw new Error('not used'); },
  };
  const catalog = {
    upsertMovies: async () => undefined, publishSearch: async () => undefined,
    readSearch: async () => staleEnglish,
    readMovies: async () => [], hasMovie: async () => true,
    writeMovieDetail: async () => undefined, readMovieDetail: async () => null,
  };

  const result = await new MovieService(store, {} as never, provider, catalog).search('movie', 1, 'en-US', null);
  assert.equal(result.items[0]?.title, 'Old English title');
  assert.equal(result.source, 'local-fallback');
});

test('search rejects a different-locale cache when TMDB fails', async () => {
  const store = new MemoryTrendingStore();
  const catalog = {
    upsertMovies: async () => undefined, publishSearch: async () => undefined,
    readSearch: async () => ({
      page: 1, totalPages: 1, totalResults: 1, fetchedAt,
      movies: [{ tmdbId: 42, title: '中文缓存', genreIds: [], localizationLocale: 'zh-CN' as const, summarySyncedAt: fetchedAt }],
    }),
    readMovies: async () => [], hasMovie: async () => true,
    writeMovieDetail: async () => undefined, readMovieDetail: async () => null,
  };
  const provider = {
    search: async () => { throw new Error('TMDB unavailable'); },
    fetchDetails: async () => { throw new Error('not used'); },
  };

  await assert.rejects(
    () => new MovieService(store, {} as never, provider, catalog).search('movie', 1, 'en-US', null),
    /TMDB unavailable/,
  );
});

test('detail fetches, persists, and returns cast and director metadata', async () => {
  const store = new MemoryTrendingStore();
  let persisted = false;
  const detail = {
    tmdbId: 42, title: '电影', overview: '剧情', genreIds: [18], genres: [{ tmdbId: 18, name: '剧情' }],
    runtimeMinutes: 120, cast: [{ person: { tmdbId: 1, name: '演员' }, creditId: 'cast-1', type: 'cast' as const, character: '角色' }],
    directors: [{ person: { tmdbId: 2, name: '导演' }, creditId: 'director-1', type: 'director' as const }],
  };
  const provider = { search: async () => ({ page: 1, totalPages: 1, totalResults: 0, movies: [] }), fetchDetails: async () => detail };
  const catalog = {
    upsertMovies: async () => undefined, readMovies: async () => [], hasMovie: async () => false, readMovieDetail: async () => null,
    publishSearch: async () => undefined, readSearch: async () => null,
    writeMovieDetail: async () => { persisted = true; },
  };
  const service = new MovieService(store, {} as never, provider, catalog);
  const result = await service.detail(42, 'zh-CN', null);
  assert.equal(persisted, true);
  assert.equal(result.runtimeMinutes, 120);
  assert.deepEqual(result.cast.map(({ name, character }) => ({ name, character })), [{ name: '演员', character: '角色' }]);
  assert.deepEqual(result.directors.map(({ name }) => name), ['导演']);
  assert.equal(result.stale, false);
  assert.equal(result.locale, 'zh-CN');
});

test('detail never falls back to another locale when TMDB fails', async () => {
  const store = new MemoryTrendingStore();
  let providerCalls = 0;
  const fallbackDetail = {
    tmdbId: 42, title: '中文电影', genreIds: [], genres: [], cast: [], directors: [],
    detailSyncedAt: new Date(), localizationLocale: 'zh-CN' as const,
  };
  const provider = {
    search: async () => ({ page: 1, totalPages: 1, totalResults: 0, movies: [] }),
    fetchDetails: async () => { providerCalls += 1; throw new Error('TMDB unavailable'); },
  };
  const catalog = {
    upsertMovies: async () => undefined, publishSearch: async () => undefined, readSearch: async () => null,
    readMovies: async () => [], hasMovie: async () => true,
    writeMovieDetail: async () => undefined, readMovieDetail: async () => fallbackDetail,
  };

  const service = new MovieService(store, {} as never, provider, catalog);
  await assert.rejects(() => service.detail(42, 'en-US', null), /TMDB unavailable/);
  assert.equal(providerCalls, 1);
});

test('detail falls back to stale detail only in the requested locale', async () => {
  const store = new MemoryTrendingStore();
  const staleEnglish = {
    tmdbId: 42, title: 'Old English detail', genreIds: [], genres: [], cast: [], directors: [],
    detailSyncedAt: new Date(0), localizationLocale: 'en-US' as const,
  };
  const provider = {
    search: async () => ({ page: 1, totalPages: 1, totalResults: 0, movies: [] }),
    fetchDetails: async () => { throw new Error('TMDB unavailable'); },
  };
  const catalog = {
    upsertMovies: async () => undefined, publishSearch: async () => undefined, readSearch: async () => null,
    readMovies: async () => [], hasMovie: async () => true,
    writeMovieDetail: async () => undefined, readMovieDetail: async () => staleEnglish,
  };

  const result = await new MovieService(store, {} as never, provider, catalog).detail(42, 'en-US', null);
  assert.equal(result.title, 'Old English detail');
  assert.equal(result.locale, 'en-US');
  assert.equal(result.stale, true);
});
