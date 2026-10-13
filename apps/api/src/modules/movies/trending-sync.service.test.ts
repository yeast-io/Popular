import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  SyncLock, TrendingPageRecord, TrendingProvider, TrendingSnapshotRecord, TrendingStore,
} from './movie.types.js';
import { TrendingSyncService } from './trending-sync.service.js';

class MemoryLogger {
  readonly entries: Array<{ level: 'info' | 'error'; bindings: Record<string, unknown>; message: string }> = [];
  info(bindings: Record<string, unknown>, message: string) { this.entries.push({ level: 'info', bindings, message }); }
  error(bindings: Record<string, unknown>, message: string) { this.entries.push({ level: 'error', bindings, message }); }
}

class MemoryStore implements TrendingStore {
  readonly published: Array<{ locale: string; snapshot: TrendingSnapshotRecord }> = [];
  readonly appended: Array<{ locale: string; generation: string; sourcePage: number; pageSize: number; page: TrendingPageRecord }> = [];

  async publishSnapshot(snapshot: TrendingSnapshotRecord, locale: string) { this.published.push({ locale, snapshot }); }
  async appendSnapshotPage(page: TrendingPageRecord, locale: string, generation: string, sourcePage: number, pageSize: number) {
    this.appended.push({ locale, generation, sourcePage, pageSize, page });
  }
  async readPage() { return null; }
  async readSnapshot(locale: string, generation: string) {
    const published = this.published.find((entry) => entry.locale === locale && entry.snapshot.generation === generation)?.snapshot;
    if (!published) return null;
    return {
      ...published,
      pages: [...published.pages, ...this.appended
        .filter((entry) => entry.locale === locale && entry.generation === generation)
        .map((entry) => entry.page)],
      sourcePage: this.appended.filter((entry) => entry.locale === locale && entry.generation === generation).at(-1)?.sourcePage
        ?? published.sourcePage,
    };
  }
}

const lock: SyncLock = { acquire: async () => 'owner', release: async () => undefined };

test('single-page sync publishes a new snapshot only after the provider result is available', async () => {
  const store = new MemoryStore();
  const provider: TrendingProvider = { fetchPage: async (page) => ({
    page, totalPages: 1, totalResults: 1, movies: [{ tmdbId: 1, title: 'Movie', genreIds: [] }],
  }) };
  const logger = new MemoryLogger();
  const result = await new TrendingSyncService(provider, store, lock, 'zh-CN', 60, logger).syncPage(1, 'request', 'zh-CN');

  assert.equal(result.status, 'completed');
  assert.equal(store.published.length, 1);
  assert.equal(store.published[0]?.snapshot.pages[0]?.movies[0]?.tmdbId, 1);
  assert.equal(typeof store.published[0]?.snapshot.generation, 'string');
  assert.deepEqual(logger.entries.map(({ message }) => message), [
    'TMDB trending sync started', 'TMDB trending page fetch started',
    'TMDB trending page fetched', 'TMDB trending sync completed',
  ]);
});

test('configured sync removes cross-page duplicates and backfills from later source pages', async () => {
  const calls: number[] = [];
  const results = new Map([[1, [1, 2]], [2, [2, 3]], [3, [4, 5]]]);
  const provider: TrendingProvider = { fetchPage: async (page) => {
    calls.push(page);
    return {
      page, totalPages: 3, totalResults: 5,
      movies: (results.get(page) ?? []).map((tmdbId) => ({ tmdbId, title: `Movie ${tmdbId}`, genreIds: [] })),
    };
  } };
  const store = new MemoryStore();

  await new TrendingSyncService(provider, store, lock, 'zh-CN', 60, new MemoryLogger())
    .syncConfiguredPages(2, 2, 'scheduler');

  const snapshot = store.published[0]!.snapshot;
  assert.deepEqual(calls, [1, 2, 3]);
  assert.deepEqual(snapshot.pages.map((page) => page.movies.map(({ tmdbId }) => tmdbId)), [[1, 2], [3, 4]]);
  assert.equal(new Set(snapshot.pages.flatMap((page) => page.movies.map(({ tmdbId }) => tmdbId))).size, 4);
  assert.equal(snapshot.sourcePage, 3);
  assert.equal(snapshot.pages[0]?.fetchedAt, snapshot.pages[1]?.fetchedAt);
});

test('load-more extends the requested generation and backfills overlaps', async () => {
  const generation = '00000000-0000-4000-8000-000000000001';
  const fetchedAt = new Date('2026-10-13T00:00:00.000Z');
  const store = new MemoryStore();
  store.published.push({ locale: 'en-US', snapshot: {
    generation, sourcePage: 1, pageSize: 2, fetchedAt,
    pages: [{
      page: 1, totalPages: 3, totalResults: 4, fetchedAt,
      movies: [{ tmdbId: 1, title: 'One', genreIds: [] }, { tmdbId: 2, title: 'Two', genreIds: [] }],
    }],
  } });
  const provider: TrendingProvider = { fetchPage: async (page) => ({
    page, totalPages: 3, totalResults: 4,
    movies: (page === 2 ? [2, 3] : [3, 4]).map((tmdbId) => ({ tmdbId, title: `${tmdbId}`, genreIds: [] })),
  }) };

  await new TrendingSyncService(provider, store, lock, 'zh-CN', 60, new MemoryLogger())
    .syncPage(2, 'load-more', 'en-US', generation);

  assert.equal(store.appended[0]?.generation, generation);
  assert.equal(store.appended[0]?.sourcePage, 3);
  assert.equal(store.appended[0]?.page.fetchedAt, fetchedAt);
  assert.deepEqual(store.appended[0]?.page.movies.map(({ tmdbId }) => tmdbId), [3, 4]);
});

test('page sync scopes provider, publication, and distributed lock to the requested locale', async () => {
  let providerLocale = '';
  let publishedLocale = '';
  let lockKey = '';
  const provider: TrendingProvider = { fetchPage: async (page, locale) => {
    providerLocale = locale;
    return { page, totalPages: 1, totalResults: 0, movies: [] };
  } };
  const store = new MemoryStore();
  store.publishSnapshot = async (_snapshot, locale) => { publishedLocale = locale; };
  const scopedLock: SyncLock = {
    acquire: async (key) => { lockKey = key; return 'owner'; }, release: async () => undefined,
  };

  await new TrendingSyncService(provider, store, scopedLock, 'zh-CN', 60, new MemoryLogger()).syncPage(1, 'request', 'en-US');
  assert.equal(providerLocale, 'en-US');
  assert.equal(publishedLocale, 'en-US');
  assert.equal(lockKey, 'lock:sync:trending:movie:week:en-US:page:1:new');
});

test('configured automatic sync uses only the configured default locale', async () => {
  const locales: string[] = [];
  const provider: TrendingProvider = { fetchPage: async (page, locale) => {
    locales.push(locale);
    return { page, totalPages: 2, totalResults: 0, movies: [] };
  } };

  await new TrendingSyncService(provider, new MemoryStore(), lock, 'zh-CN', 60, new MemoryLogger())
    .syncConfiguredPages(2, 2, 'scheduler');
  assert.deepEqual(locales, ['zh-CN', 'zh-CN']);
});

test('sync skips without calling TMDB when the distributed lock is held', async () => {
  let calls = 0;
  const provider: TrendingProvider = { fetchPage: async () => { calls += 1; throw new Error('must not run'); } };
  const heldLock: SyncLock = { acquire: async () => null, release: async () => undefined };
  const logger = new MemoryLogger();
  const result = await new TrendingSyncService(provider, new MemoryStore(), heldLock, 'zh-CN', 60, logger)
    .syncPage(1, 'request', 'zh-CN');
  assert.equal(result.status, 'skipped');
  assert.equal(calls, 0);
  assert.equal(logger.entries.at(-1)?.message, 'TMDB trending sync skipped');
  assert.equal(logger.entries.at(-1)?.bindings.skipReason, 'distributed-lock-held');
});

test('sync failure logs the error once with its trigger and page', async () => {
  const failure = new Error('TMDB unavailable');
  const provider: TrendingProvider = { fetchPage: async () => { throw failure; } };
  const logger = new MemoryLogger();
  const service = new TrendingSyncService(provider, new MemoryStore(), lock, 'zh-CN', 60, logger);

  await assert.rejects(service.syncPage(1, 'scheduler', 'zh-CN'), failure);
  const errorEntries = logger.entries.filter(({ level }) => level === 'error');
  assert.equal(errorEntries.length, 1);
  assert.equal(errorEntries[0]?.message, 'TMDB trending sync failed');
  assert.equal(errorEntries[0]?.bindings.err, failure);
  assert.equal(errorEntries[0]?.bindings.trigger, 'scheduler');
  assert.equal(errorEntries[0]?.bindings.page, 1);
});
