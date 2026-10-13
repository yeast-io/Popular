import assert from 'node:assert/strict';
import test from 'node:test';
import type { MovieRecord, MovieStatusRecord } from '../movies/movie.types.js';
import { MovieStatusService } from './movie-status.service.js';

const movies = new Map<number, MovieRecord>([[7, { tmdbId: 7, title: '七号电影', posterPath: '/seven.jpg', genreIds: [] }]]);
const rows: MovieStatusRecord[] = [];
const catalog = {
  upsertMovies: async () => undefined,
  readMovies: async (ids: number[]) => ids.flatMap((id) => { const movie = movies.get(id); return movie ? [movie] : []; }),
  hasMovie: async (id: number) => movies.has(id),
  writeMovieDetail: async () => undefined,
  readMovieDetail: async () => null,
  publishSearch: async () => undefined,
  readSearch: async () => null,
};
const store = {
  set: async (_ownerId: string, tmdbId: number, status: MovieStatusRecord['status']) => {
    const existing = rows.find((row) => row.tmdbId === tmdbId);
    const previous = existing?.status ?? null;
    if (existing) existing.status = status; else rows.push({ tmdbId, status, updatedAt: new Date() });
    return previous;
  },
  delete: async (_ownerId: string, tmdbId: number) => { const index = rows.findIndex((row) => row.tmdbId === tmdbId); if (index >= 0) rows.splice(index, 1); },
  readForMovies: async () => rows,
  list: async () => ({ items: rows, total: rows.length }),
};

test('set, list, and clear form a complete personal movie-state flow', async () => {
  rows.length = 0;
  const service = new MovieStatusService(store, catalog, 'zh-CN');
  assert.deepEqual(await service.set('owner-a', 7, 'watched'), { tmdbId: 7, status: 'watched' });
  const list = await service.list('owner-a', 'watched', 1, 20);
  assert.equal(list.items[0]?.title, '七号电影');
  assert.equal(list.items[0]?.userStatus, 'watched');
  assert.equal(list.locale, 'zh-CN');
  assert.deepEqual(await service.clear('owner-a', 7), { tmdbId: 7, status: 'unwatched' });
});

test('cannot create a dangling status for an unknown movie', async () => {
  const service = new MovieStatusService(store, catalog, 'zh-CN');
  await assert.rejects(() => service.set('owner-a', 999, 'interested'), { statusCode: 404, code: 'NOT_FOUND' });
});

test('My Movies requests localized movie records without changing saved states', async () => {
  let requestedLocale = '';
  const localizedCatalog = {
    ...catalog,
    readMovies: async (_ids: number[], locale: string) => {
      requestedLocale = locale;
      return [{ tmdbId: 7, title: 'Movie Seven', genreIds: [], localizationLocale: 'en-US' as const }];
    },
  };
  rows.length = 0;
  rows.push({ tmdbId: 7, status: 'interested', updatedAt: new Date() });

  const result = await new MovieStatusService(store, localizedCatalog, 'zh-CN')
    .list('owner-a', 'interested', 1, 20, 'en-US');

  assert.equal(requestedLocale, 'en-US');
  assert.equal(result.locale, 'en-US');
  assert.equal(result.items[0]?.title, 'Movie Seven');
  assert.equal(result.items[0]?.userStatus, 'interested');
});

test('transitioning to interested schedules a forced background check after saving', async () => {
  rows.length = 0;
  const calls: Array<{ ownerId: string; tmdbId: number; force: boolean }> = [];
  const service = new MovieStatusService(store, catalog, 'zh-CN', {
    schedule: (ownerId, tmdbId, options) => calls.push({ ownerId, tmdbId, force: options?.force === true }),
  });

  await service.set('owner-a', 7, 'interested');
  await service.set('owner-a', 7, 'interested');

  assert.deepEqual(calls, [{ ownerId: 'owner-a', tmdbId: 7, force: true }]);
});

test('listing interested movies schedules checks without awaiting remote work', async () => {
  rows.length = 0;
  rows.push({ tmdbId: 7, status: 'interested', updatedAt: new Date() });
  const calls: number[] = [];
  const service = new MovieStatusService(store, catalog, 'zh-CN', {
    schedule: (_ownerId, tmdbId) => { calls.push(tmdbId); },
  });

  const result = await service.list('owner-a', 'interested', 1, 20);

  assert.equal(result.items.length, 1);
  assert.deepEqual(calls, [7]);
  assert.deepEqual(result.items[0]?.resourceCheck, {
    provider: 'mteam',
    checking: false,
    availability: 'unchecked',
  });
});

test('My Movies exposes a failed refresh while preserving the last successful availability', async () => {
  rows.length = 0;
  rows.push({ tmdbId: 7, status: 'interested', updatedAt: new Date() });
  const checkedAt = new Date('2026-10-12T00:00:00.000Z');
  const attemptedAt = new Date('2026-10-13T00:00:00.000Z');
  const service = new MovieStatusService(store, catalog, 'zh-CN', undefined, {
    readOne: async () => null,
    readForMovies: async () => [{
      ownerId: 'owner-a',
      tmdbId: 7,
      provider: 'mteam',
      checking: false,
      availability: 'available',
      checkedAt,
      expiresAt: new Date('2026-10-12T12:00:00.000Z'),
      lastAttemptAt: attemptedAt,
      lastAttemptStatus: 'error',
      lastErrorCode: 'timeout',
    }],
  });

  const result = await service.list('owner-a', 'interested', 1, 20);

  assert.deepEqual(result.items[0]?.resourceCheck, {
    provider: 'mteam',
    checking: false,
    availability: 'available',
    checkedAt: checkedAt.toISOString(),
    expiresAt: '2026-10-12T12:00:00.000Z',
    lastAttemptAt: attemptedAt.toISOString(),
    lastAttemptStatus: 'error',
    lastErrorCode: 'MTEAM_TIMEOUT',
  });
});
