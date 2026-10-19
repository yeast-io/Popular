import assert from 'node:assert/strict';
import test from 'node:test';
import { MongoTrendingStore, searchKey, trendingGenerationKey, trendingKey } from './movie.store.js';

test('Chinese and English summaries use separate localization identities', async () => {
  const movieWrites: unknown[] = [];
  const localizationWrites: unknown[] = [];
  const movies = {
    bulkWrite: async (writes: unknown[]) => {
      movieWrites.push(...writes);
    },
  };
  const localizations = {
    bulkWrite: async (writes: unknown[]) => {
      localizationWrites.push(...writes);
    },
  };
  const store = new MongoTrendingStore(movies as never, localizations as never, {} as never);
  const syncedAt = new Date('2026-10-12T00:00:00.000Z');

  await store.upsertMovies(
    [
      {
        tmdbId: 42,
        title: '中文标题',
        overview: '中文简介',
        posterPath: '/zh-poster.jpg',
        backdropPath: '/zh-backdrop.jpg',
        genreIds: [18],
      },
    ],
    syncedAt,
    'zh-CN',
  );
  await store.upsertMovies(
    [
      {
        tmdbId: 42,
        title: 'English title',
        overview: 'English overview',
        posterPath: '/en-poster.jpg',
        backdropPath: '/en-backdrop.jpg',
        genreIds: [18],
      },
    ],
    syncedAt,
    'en-US',
  );

  assert.equal(movieWrites.length, 2);
  assert.equal(localizationWrites.length, 2);
  const operations = localizationWrites as Array<{ updateOne: { filter: unknown; update: { $set: unknown } } }>;
  assert.deepEqual(
    operations.map(({ updateOne }) => updateOne.filter),
    [
      { movieTmdbId: 42, locale: 'zh-CN' },
      { movieTmdbId: 42, locale: 'en-US' },
    ],
  );
  assert.deepEqual(
    operations.map(({ updateOne }) => updateOne.update.$set),
    [
      {
        title: '中文标题',
        overview: '中文简介',
        posterPath: '/zh-poster.jpg',
        backdropPath: '/zh-backdrop.jpg',
        summarySyncedAt: syncedAt,
      },
      {
        title: 'English title',
        overview: 'English overview',
        posterPath: '/en-poster.jpg',
        backdropPath: '/en-backdrop.jpg',
        summarySyncedAt: syncedAt,
      },
    ],
  );
  const baseOperations = movieWrites as Array<{
    updateOne: { update: { $set: Record<string, unknown>; $setOnInsert: unknown } };
  }>;
  assert.equal('tmdbId' in baseOperations[0]!.updateOne.update.$set, false);
  assert.equal('posterPath' in baseOperations[0]!.updateOne.update.$set, false);
  assert.equal('backdropPath' in baseOperations[0]!.updateOne.update.$set, false);
  assert.deepEqual(baseOperations[0]!.updateOne.update.$setOnInsert, { tmdbId: 42 });
  assert.equal(JSON.stringify(movieWrites).includes('中文标题'), false);
  assert.equal(JSON.stringify(movieWrites).includes('English title'), false);
});

test('movie detail upsert keeps image paths scoped to the requested locale', async () => {
  const movieUpdates: unknown[][] = [];
  const localizationUpdates: unknown[][] = [];
  const movies = {
    updateOne: async (...args: unknown[]) => {
      movieUpdates.push(args);
    },
  };
  const localizations = {
    updateOne: async (...args: unknown[]) => {
      localizationUpdates.push(args);
    },
  };
  const people = { bulkWrite: async () => undefined };
  const credits = { insertMany: async () => undefined, deleteMany: async () => undefined };
  const store = new MongoTrendingStore(
    movies as never,
    localizations as never,
    {} as never,
    people as never,
    credits as never,
  );

  await store.writeMovieDetail(
    {
      tmdbId: 42,
      title: 'Movie',
      posterPath: '/en-poster.jpg',
      backdropPath: '/en-backdrop.jpg',
      genreIds: [18],
      genres: [],
      cast: [],
      directors: [],
    },
    new Date('2026-10-12T00:00:00.000Z'),
    'en-US',
  );

  const update = movieUpdates[0]?.[1] as { $set: Record<string, unknown>; $setOnInsert: unknown };
  assert.equal('tmdbId' in update.$set, false);
  assert.equal('posterPath' in update.$set, false);
  assert.equal('backdropPath' in update.$set, false);
  assert.deepEqual(update.$setOnInsert, { tmdbId: 42 });
  assert.deepEqual(localizationUpdates[0]?.[0], { movieTmdbId: 42, locale: 'en-US' });
  const localizationUpdate = localizationUpdates[0]?.[1] as { $set: Record<string, unknown> };
  assert.equal(localizationUpdate.$set.posterPath, '/en-poster.jpg');
  assert.equal(localizationUpdate.$set.backdropPath, '/en-backdrop.jpg');
});

test('movie detail stores a localized trailer and clears it when TMDB no longer returns one', async () => {
  const localizationUpdates: unknown[][] = [];
  const movies = { updateOne: async () => undefined };
  const localizations = {
    updateOne: async (...args: unknown[]) => {
      localizationUpdates.push(args);
    },
  };
  const people = { bulkWrite: async () => undefined };
  const credits = { insertMany: async () => undefined, deleteMany: async () => undefined };
  const store = new MongoTrendingStore(
    movies as never,
    localizations as never,
    {} as never,
    people as never,
    credits as never,
  );
  const base = { tmdbId: 42, title: 'Movie', genreIds: [], genres: [], cast: [], directors: [] };

  await store.writeMovieDetail(
    {
      ...base,
      trailer: {
        tmdbVideoId: 'tmdb-video',
        provider: 'youtube',
        providerVideoId: 'youtube-key',
        name: 'Official trailer',
        language: 'en',
        region: 'US',
        official: true,
        publishedAt: new Date('2026-10-12T00:00:00.000Z'),
      },
    },
    new Date('2026-10-13T00:00:00.000Z'),
    'en-US',
  );
  await store.writeMovieDetail(base, new Date('2026-10-14T00:00:00.000Z'), 'en-US');

  const stored = localizationUpdates[0]?.[1] as { $set: Record<string, unknown>; $unset?: Record<string, unknown> };
  assert.deepEqual(stored.$set.trailer, {
    tmdbVideoId: 'tmdb-video',
    provider: 'youtube',
    providerVideoId: 'youtube-key',
    name: 'Official trailer',
    language: 'en',
    region: 'US',
    official: true,
    publishedAt: new Date('2026-10-12T00:00:00.000Z'),
  }
  );
  assert.deepEqual(stored.$set.trailerSyncedAt, new Date('2026-10-13T00:00:00.000Z'));
  assert.equal(stored.$unset, undefined);
  const cleared = localizationUpdates[1]?.[1] as { $unset?: Record<string, unknown> };
  assert.deepEqual(cleared.$unset, { trailer: 1 });
});

test('reads the image paths belonging to the requested locale', async () => {
  const movies = {
    find: () => {
      return {
        lean: () => {
          return { exec: async () => [{ tmdbId: 42, genreIds: [], posterPath: '/legacy.jpg' }] };
        },
      };
    },
  };
  const localizations = {
    find: (filter: { locale: string }) => {
      return {
        lean: () => {
          return {
            exec: async () => {
              return [
                {
                  movieTmdbId: 42,
                  locale: filter.locale,
                  title: filter.locale === 'zh-CN' ? '中文标题' : 'English title',
                  posterPath: filter.locale === 'zh-CN' ? '/zh-poster.jpg' : '/en-poster.jpg',
                  summarySyncedAt: new Date('2026-10-12T00:00:00.000Z'),
                },
              ];
            },
          };
        },
      };
    },
  };
  const store = new MongoTrendingStore(movies as never, localizations as never, {} as never);

  const [chinese] = await store.readMovies([42], 'zh-CN');
  const [english] = await store.readMovies([42], 'en-US');

  assert.equal(chinese?.posterPath, '/zh-poster.jpg');
  assert.equal(english?.posterPath, '/en-poster.jpg');
});

test('trending and search cache keys are isolated by locale', () => {
  assert.notEqual(trendingKey('zh-CN', 1), trendingKey('en-US', 1));
  assert.notEqual(searchKey('Movie', 'zh-CN', 1), searchKey('Movie', 'en-US', 1));
  assert.match(trendingKey('en-US', 1), /:en-US:/);
  assert.match(searchKey('Movie', 'zh-CN', 1), /^search:movie:zh-CN:/);
});

test('publishes every generation page before switching the active pointer', async () => {
  const calls: string[] = [];
  const resultWrites: unknown[][] = [];
  const movies = {
    bulkWrite: async () => {
      calls.push('movies');
    },
  };
  const localizations = {
    bulkWrite: async () => {
      calls.push('localizations');
    },
  };
  const resultSets = {
    bulkWrite: async (writes: unknown[]) => {
      calls.push('pages');
      resultWrites.push(writes);
    },
    updateMany: async () => {
      calls.push('expire-old');
    },
  };
  const states = {
    updateOne: async () => {
      calls.push('activate');
    },
  };
  const store = new MongoTrendingStore(
    movies as never,
    localizations as never,
    resultSets as never,
    undefined,
    undefined,
    states as never,
  );
  const generation = '00000000-0000-4000-8000-000000000001';
  const fetchedAt = new Date('2026-10-13T00:00:00.000Z');

  await store.publishSnapshot(
    {
      generation,
      sourcePage: 3,
      pageSize: 1,
      fetchedAt,
      pages: [1, 2].map((page) => {
        return {
          page,
          totalPages: 10,
          totalResults: 10,
          fetchedAt,
          movies: [{ tmdbId: page, title: `Movie ${page}`, genreIds: [] }],
        };
      }),
    },
    'zh-CN',
  );

  assert.deepEqual(calls, ['movies', 'localizations', 'pages', 'activate', 'expire-old']);
  const writes = resultWrites[0] as Array<{
    updateOne: { filter: { key: string }; update: { $set: { generation: string } } };
  }>;
  assert.deepEqual(
    writes.map(({ updateOne }) => updateOne.filter.key),
    [trendingGenerationKey('zh-CN', generation, 1), trendingGenerationKey('zh-CN', generation, 2)],
  );
  assert.equal(
    writes.every(({ updateOne }) => updateOne.update.$set.generation === generation),
    true,
  );
});
