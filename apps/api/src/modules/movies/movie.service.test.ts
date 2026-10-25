import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  MovieRecord,
  MovieStatusRecord,
  TrendingPageRecord,
} from './movie.types.js';
import { MovieService } from './movie.service.js';

const generation = '00000000-0000-4000-8000-000000000001';

class MemoryTrendingStore {
  readonly pages = new Map<string, TrendingPageRecord>();

  async page(page: number, locale: 'zh-CN' | 'en-US') {
    const record = this.pages.get(`${locale}:${page}`)!;
    return { ...record, items: record.movies, generation, fetchedAt: record.fetchedAt.toISOString(), hasMore: page < record.totalPages };
  }
}

const fetchedAt = new Date('2026-10-12T00:00:00.000Z');

test('trending preserves source order and maps optional presentation fields', async () => {
  const store = new MemoryTrendingStore();
  store.pages.set('zh-CN:1', {
    page: 1,
    totalPages: 2,
    totalResults: 2,
    fetchedAt,
    movies: [
      {
        tmdbId: 20,
        title: '第二十部',
        originalTitle: 'Twenty',
        releaseDate: '2026-10-10',
        posterPath: '/poster.jpg',
        genreIds: [],
        voteAverage: 8.25,
      },
      { tmdbId: 3, title: '第三部', genreIds: [] },
    ],
  }
  );
  const service = new MovieService(store);

  const result = await service.trending(1, 'zh-CN', null);
  assert.deepEqual(
    result.items.map(({ tmdbId }) => tmdbId),
    [20, 3]
  );
  assert.equal(result.items[0]?.posterUrl, 'https://image.tmdb.org/t/p/w500/poster.jpg');
  assert.equal(result.items[1]?.posterUrl, undefined);
  assert.equal(result.items[0]?.userStatus, 'unwatched');
  assert.equal(result.hasMore, true);
  assert.equal(result.generation, generation);
  assert.equal(result.locale, 'zh-CN');
});

test('load more delegates the next page with the pinned generation, locale and owner', async () => {
  const reader = { page: async (page: number, locale: 'zh-CN' | 'en-US', owner: string | null, version?: string) => {
    assert.equal(page, 2);
    assert.equal(locale, 'en-US');
    assert.equal(owner, 'owner');
    assert.equal(version, generation);
    return { items: [], page, totalPages: 2, totalResults: 1, fetchedAt: fetchedAt.toISOString(), generation, hasMore: false };
  } };
  const result = await new MovieService(reader).loadMore(1, generation, 'en-US', 'owner');
  assert.equal(result.page, 2);
});

test('search caches results and merges statuses for the authenticated owner', async () => {
  const store = new MemoryTrendingStore();
  let cached: MovieRecord[] = [];
  const catalog = {
    upsertMovies: async (movies: MovieRecord[]) => {
      cached = movies;
    },
    publishSearch: async (_query: string, record: TrendingPageRecord) => {
      cached = record.movies;
    },
    readSearch: async () => null,
    readMovies: async () => [],
    hasMovie: async () => false,
    writeMovieDetail: async () => undefined,
    readMovieDetail: async () => null,
  };
  const provider = {
    search: async () => {
      return {
        page: 1,
        totalPages: 2,
        totalResults: 1,
        movies: [{ tmdbId: 42, title: '银河', originalTitle: 'Galaxy', genreIds: [] }],
      };
    },
    fetchDetails: async () => {
      throw new Error('not used');
    },
  };
  const statuses = {
    readForMovies: async (ownerId: string): Promise<MovieStatusRecord[]> => {
      assert.equal(ownerId, 'owner-1');
      return [{ tmdbId: 42, status: 'interested', preference: 'liked', updatedAt: fetchedAt }];
    },
  };
  const service = new MovieService(store, provider, catalog, statuses as never);

  const result = await service.search(' 银河 ', 1, 'en-US', 'owner-1');

  assert.equal(cached[0]?.tmdbId, 42);
  assert.equal(result.items[0]?.userStatus, 'interested');
  assert.equal(result.items[0]?.userPreference, 'liked');
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
    readSearch: async () => {
      return {
        page: 1,
        totalPages: 1,
        totalResults: 1,
        fetchedAt: new Date(),
        movies: [
          {
            tmdbId: 42,
            title: 'Cached title',
            genreIds: [],
            localizationLocale: 'en-US' as const,
            summarySyncedAt: new Date(),
          },
        ],
      };
    },
    readMovies: async () => [],
    hasMovie: async () => true,
    writeMovieDetail: async () => undefined,
    readMovieDetail: async () => null,
  };
  const provider = {
    search: async () => {
      providerCalls += 1;
      throw new Error('must not fetch');
    },
    fetchDetails: async () => {
      throw new Error('not used');
    },
  };

  const result = await new MovieService(store, provider, catalog).search('movie', 1, 'en-US', null);
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
    readSearch: async () => {
      return {
        page: 1,
        totalPages: 1,
        totalResults: 1,
        fetchedAt: new Date(),
        movies: [
          {
            tmdbId: 42,
            title: 'Fallback title',
            genreIds: [],
            localizationLocale: 'zh-CN' as const,
            summarySyncedAt: new Date(),
          },
        ],
      };
    },
    readMovies: async () => [],
    hasMovie: async () => true,
    writeMovieDetail: async () => undefined,
    readMovieDetail: async () => null,
  };
  const provider = {
    search: async () => {
      providerCalls += 1;
      return {
        page: 1,
        totalPages: 1,
        totalResults: 1,
        movies: [{ tmdbId: 42, title: 'English title', genreIds: [] }],
      };
    },
    fetchDetails: async () => {
      throw new Error('not used');
    },
  };

  const result = await new MovieService(store, provider, catalog).search('movie', 1, 'en-US', null);
  assert.equal(providerCalls, 1);
  assert.equal(result.items[0]?.title, 'English title');
  assert.equal(result.source, 'tmdb');
});

test('search falls back only to a stale cache in the requested locale', async () => {
  const store = new MemoryTrendingStore();
  const staleEnglish = {
    page: 1,
    totalPages: 1,
    totalResults: 1,
    fetchedAt,
    movies: [
      {
        tmdbId: 42,
        title: 'Old English title',
        genreIds: [],
        localizationLocale: 'en-US' as const,
        summarySyncedAt: new Date(0),
      },
    ],
  };
  const provider = {
    search: async () => {
      throw new Error('TMDB unavailable');
    },
    fetchDetails: async () => {
      throw new Error('not used');
    },
  };
  const catalog = {
    upsertMovies: async () => undefined,
    publishSearch: async () => undefined,
    readSearch: async () => staleEnglish,
    readMovies: async () => [],
    hasMovie: async () => true,
    writeMovieDetail: async () => undefined,
    readMovieDetail: async () => null,
  };

  const result = await new MovieService(store, provider, catalog).search('movie', 1, 'en-US', null);
  assert.equal(result.items[0]?.title, 'Old English title');
  assert.equal(result.source, 'local-fallback');
});

test('search rejects a different-locale cache when TMDB fails', async () => {
  const store = new MemoryTrendingStore();
  const catalog = {
    upsertMovies: async () => undefined,
    publishSearch: async () => undefined,
    readSearch: async () => {
      return {
        page: 1,
        totalPages: 1,
        totalResults: 1,
        fetchedAt,
        movies: [
          {
            tmdbId: 42,
            title: '中文缓存',
            genreIds: [],
            localizationLocale: 'zh-CN' as const,
            summarySyncedAt: fetchedAt,
          },
        ],
      };
    },
    readMovies: async () => [],
    hasMovie: async () => true,
    writeMovieDetail: async () => undefined,
    readMovieDetail: async () => null,
  };
  const provider = {
    search: async () => {
      throw new Error('TMDB unavailable');
    },
    fetchDetails: async () => {
      throw new Error('not used');
    },
  };

  await assert.rejects(
    () => new MovieService(store, provider, catalog).search('movie', 1, 'en-US', null),
    /TMDB unavailable/
  );
});

test('detail fetches, persists, and returns cast and director metadata', async () => {
  const store = new MemoryTrendingStore();
  let persisted = false;
  const detail = {
    tmdbId: 42,
    title: '电影',
    overview: '剧情',
    genreIds: [18],
    genres: [{ tmdbId: 18, name: '剧情' }],
    runtimeMinutes: 120,
    cast: [{ person: { tmdbId: 1, name: '演员' }, creditId: 'cast-1', type: 'cast' as const, character: '角色' }],
    directors: [{ person: { tmdbId: 2, name: '导演', originalName: 'Director Name' }, creditId: 'director-1', type: 'director' as const }],
    trailer: {
      tmdbVideoId: 'video-1',
      provider: 'youtube' as const,
      providerVideoId: 'youtube-key',
      name: '官方预告',
      language: 'zh',
      official: true,
      publishedAt: new Date('2026-10-12T00:00:00.000Z'),
    },
  };
  const provider = {
    search: async () => {
      return { page: 1, totalPages: 1, totalResults: 0, movies: [] };
    },
    fetchDetails: async () => {
      return detail;
    },
  };
  const catalog = {
    upsertMovies: async () => {
      return undefined;
    },
    readMovies: async () => {
      return [];
    },
    hasMovie: async () => {
      return false;
    },
    readMovieDetail: async () => {
      return null;
    },
    publishSearch: async () => undefined,
    readSearch: async () => null,
    writeMovieDetail: async () => {
      persisted = true;
    },
  };
  const service = new MovieService(store, provider, catalog);
  const result = await service.detail(42, 'zh-CN', null);
  assert.equal(persisted, true);
  assert.equal(result.runtimeMinutes, 120);
  assert.equal(result.directors[0]?.originalName, 'Director Name');
  assert.deepEqual(
    result.cast.map(({ name, character }) => ({ name, character })),
    [{ name: '演员', character: '角色' }]
  );
  assert.deepEqual(
    result.directors.map(({ name }) => name),
    ['导演']
  );
  assert.deepEqual(result.trailer, {
    tmdbVideoId: 'video-1',
    provider: 'youtube',
    providerVideoId: 'youtube-key',
    name: '官方预告',
    language: 'zh',
    official: true,
    publishedAt: '2026-10-12T00:00:00.000Z',
  }
  );
  assert.equal(result.stale, false);
  assert.equal(result.locale, 'zh-CN');
});

test('detail never falls back to another locale when TMDB fails', async () => {
  const store = new MemoryTrendingStore();
  let providerCalls = 0;
  const fallbackDetail = {
    tmdbId: 42,
    title: '中文电影',
    genreIds: [],
    genres: [],
    cast: [],
    directors: [],
    detailSyncedAt: new Date(),
    localizationLocale: 'zh-CN' as const,
  };
  const provider = {
    search: async () => ({ page: 1, totalPages: 1, totalResults: 0, movies: [] }),
    fetchDetails: async () => {
      providerCalls += 1;
      throw new Error('TMDB unavailable');
    },
  };
  const catalog = {
    upsertMovies: async () => {
      return undefined;
    },
    publishSearch: async () => {
      return undefined;
    },
    readSearch: async () => {
      return null;
    },
    readMovies: async () => [],
    hasMovie: async () => true,
    writeMovieDetail: async () => undefined,
    readMovieDetail: async () => fallbackDetail,
  };

  const service = new MovieService(store, provider, catalog);
  await assert.rejects(() => service.detail(42, 'en-US', null), /TMDB unavailable/);
  assert.equal(providerCalls, 1);
});

test('detail refreshes a legacy cache once when trailer metadata has never been synchronized', async () => {
  const store = new MemoryTrendingStore();
  let providerCalls = 0;
  const legacyDetail = {
    tmdbId: 42,
    title: 'Legacy detail',
    genreIds: [],
    genres: [],
    cast: [],
    directors: [],
    detailSyncedAt: new Date(),
    localizationLocale: 'en-US' as const,
  };
  const refreshedDetail = {
    tmdbId: 42,
    title: 'Refreshed detail',
    genreIds: [],
    genres: [],
    cast: [],
    directors: [],
  };
  const provider = {
    search: async () => ({ page: 1, totalPages: 1, totalResults: 0, movies: [] }),
    fetchDetails: async () => {
      providerCalls += 1;
      return refreshedDetail;
    },
  };
  const catalog = {
    upsertMovies: async () => {
      return undefined;
    },
    publishSearch: async () => {
      return undefined;
    },
    readSearch: async () => {
      return null;
    },
    readMovies: async () => [],
    hasMovie: async () => true,
    writeMovieDetail: async () => undefined,
    readMovieDetail: async () => legacyDetail,
  };

  const result = await new MovieService(store, provider, catalog).detail(42, 'en-US', null);
  assert.equal(providerCalls, 1);
  assert.equal(result.title, 'Refreshed detail');
});

test('detail falls back to stale detail only in the requested locale', async () => {
  const store = new MemoryTrendingStore();
  const staleEnglish = {
    tmdbId: 42,
    title: 'Old English detail',
    genreIds: [],
    genres: [],
    cast: [],
    directors: [],
    detailSyncedAt: new Date(0),
    localizationLocale: 'en-US' as const,
  };
  const provider = {
    search: async () => ({ page: 1, totalPages: 1, totalResults: 0, movies: [] }),
    fetchDetails: async () => {
      throw new Error('TMDB unavailable');
    },
  };
  const catalog = {
    upsertMovies: async () => {
      return undefined;
    },
    publishSearch: async () => {
      return undefined;
    },
    readSearch: async () => {
      return null;
    },
    readMovies: async () => [],
    hasMovie: async () => true,
    writeMovieDetail: async () => undefined,
    readMovieDetail: async () => staleEnglish,
  };

  const result = await new MovieService(store, provider, catalog).detail(42, 'en-US', null);
  assert.equal(result.title, 'Old English detail');
  assert.equal(result.locale, 'en-US');
  assert.equal(result.stale, true);
});
