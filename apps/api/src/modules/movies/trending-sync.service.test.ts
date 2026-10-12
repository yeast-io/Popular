import assert from 'node:assert/strict';
import test from 'node:test';
import type { SyncLock, TrendingPageRecord, TrendingProvider, TrendingStore } from './movie.types.js';
import { TrendingSyncService } from './trending-sync.service.js';

class MemoryLogger {
  readonly entries: Array<{ level: 'info' | 'error'; bindings: Record<string, unknown>; message: string }> = [];
  info(bindings: Record<string, unknown>, message: string) { this.entries.push({ level: 'info', bindings, message }); }
  error(bindings: Record<string, unknown>, message: string) { this.entries.push({ level: 'error', bindings, message }); }
}

class MemoryStore implements TrendingStore {
  readonly published: TrendingPageRecord[] = [];
  async publishPage(record: TrendingPageRecord) { this.published.push(record); }
  async readPage() { return null; }
}

test('sync publishes a result set only after its provider result is available', async () => {
  const store = new MemoryStore();
  const provider: TrendingProvider = { fetchPage: async (page) => ({
    page, totalPages: 1, totalResults: 1, movies: [{ tmdbId: 1, title: 'Movie', genreIds: [] }],
  }) };
  const lock: SyncLock = {
    acquire: async () => 'owner',
    release: async () => undefined,
  };
  const logger = new MemoryLogger();
  const result = await new TrendingSyncService(provider, store, lock, 'zh-CN', 60, logger).syncPage(1, 'load-more', 'zh-CN');
  assert.equal(result.status, 'completed');
  assert.equal(store.published.length, 1);
  assert.equal(store.published[0]?.movies[0]?.tmdbId, 1);
  assert.deepEqual(logger.entries.map(({ message }) => message), [
    'TMDB trending sync started',
    'TMDB trending page fetch started',
    'TMDB trending page fetched and published',
    'TMDB trending sync completed',
  ]);
  assert.equal(logger.entries[0]?.bindings.trigger, 'load-more');
  assert.equal(typeof logger.entries[0]?.bindings.runId, 'string');
});

test('page sync scopes provider, publication, and distributed lock to the requested locale', async () => {
  let providerLocale = '';
  let publishedLocale = '';
  let lockKey = '';
  const provider: TrendingProvider = { fetchPage: async (page, locale) => {
    providerLocale = locale;
    return { page, totalPages: 1, totalResults: 0, movies: [] };
  } };
  const store: TrendingStore = {
    publishPage: async (_record, locale) => { publishedLocale = locale; },
    readPage: async () => null,
  };
  const lock: SyncLock = {
    acquire: async (key) => { lockKey = key; return 'owner'; },
    release: async () => undefined,
  };

  await new TrendingSyncService(provider, store, lock, 'zh-CN', 60, new MemoryLogger()).syncPage(2, 'request', 'en-US');
  assert.equal(providerLocale, 'en-US');
  assert.equal(publishedLocale, 'en-US');
  assert.equal(lockKey, 'lock:sync:trending:movie:week:en-US:page:2');
});

test('configured automatic sync uses only the configured default locale', async () => {
  const locales: string[] = [];
  const provider: TrendingProvider = { fetchPage: async (page, locale) => {
    locales.push(locale);
    return { page, totalPages: 2, totalResults: 0, movies: [] };
  } };
  const lock: SyncLock = { acquire: async () => 'owner', release: async () => undefined };

  await new TrendingSyncService(provider, new MemoryStore(), lock, 'zh-CN', 60, new MemoryLogger())
    .syncConfiguredPages(2, 2, 'scheduler');
  assert.deepEqual(locales, ['zh-CN', 'zh-CN']);
});

test('sync skips without calling TMDB when the distributed lock is held', async () => {
  let calls = 0;
  const provider: TrendingProvider = { fetchPage: async () => { calls += 1; throw new Error('must not run'); } };
  const lock: SyncLock = { acquire: async () => null, release: async () => undefined };
  const logger = new MemoryLogger();
  const result = await new TrendingSyncService(provider, new MemoryStore(), lock, 'zh-CN', 60, logger).syncPage(2, 'load-more', 'zh-CN');
  assert.equal(result.status, 'skipped');
  assert.equal(calls, 0);
  assert.equal(logger.entries.at(-1)?.message, 'TMDB trending sync skipped');
  assert.equal(logger.entries.at(-1)?.bindings.skipReason, 'distributed-lock-held');
});

test('sync failure logs the error once with its trigger and page', async () => {
  const failure = new Error('TMDB unavailable');
  const provider: TrendingProvider = { fetchPage: async () => { throw failure; } };
  const lock: SyncLock = { acquire: async () => 'owner', release: async () => undefined };
  const logger = new MemoryLogger();
  const service = new TrendingSyncService(provider, new MemoryStore(), lock, 'zh-CN', 60, logger);

  await assert.rejects(service.syncPage(3, 'scheduler', 'zh-CN'), failure);
  const errorEntries = logger.entries.filter(({ level }) => level === 'error');
  assert.equal(errorEntries.length, 1);
  assert.equal(errorEntries[0]?.message, 'TMDB trending sync failed');
  assert.equal(errorEntries[0]?.bindings.err, failure);
  assert.equal(errorEntries[0]?.bindings.trigger, 'scheduler');
  assert.equal(errorEntries[0]?.bindings.page, 3);
});
