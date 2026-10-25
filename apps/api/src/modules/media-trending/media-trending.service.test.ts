import assert from 'node:assert/strict';
import test from 'node:test';
import type { Locale } from '@movie-hub/contract';
import { MediaTrendingService } from './media-trending.service.js';
import type { MediaTrendingSnapshot } from './media-trending.schema.js';
import type { MediaTrendingKind, MediaTrendingSource, MediaTrendingStore } from './media-trending.types.js';
import { AiTrace, withAiTrace } from '../../infrastructure/logging/ai-trace.js';

interface Item { tmdbId: number; title: string }
function fixture(ttlSeconds = 900) {
  const snapshots = new Map<string, MediaTrendingSnapshot>();
  const catalog = new Map<string, Item>();
  const calls: string[] = [];
  const leases = new Map<string, string>();
  let fetcher = async (page: number, locale: Locale) => ({ items: [1, 2].map((id) => ({ tmdbId: (page - 1) * 2 + id, title: locale })), page, totalPages: 3, totalResults: 6 });
  const store: MediaTrendingStore = {
    read: async (media, locale) => structuredClone(snapshots.get(`${media}:${locale}`) ?? null),
    write: async (media, locale, record) => {
      calls.push('publish');
      snapshots.set(`${media}:${locale}`, structuredClone(record));
    },
  };
  const source: MediaTrendingSource<Item> = {
    fetch: async (page, locale, context) => {
      assert.equal(context.ownerId, 'owner');
      calls.push(`fetch:${page}:${locale}`);
      return fetcher(page, locale);
    },
    save: async (items, locale) => {
      calls.push('save');
      for (const item of items) catalog.set(`${locale}:${item.tmdbId}`, item);
    },
    read: async (ids, locale) => ids.flatMap((id) => catalog.has(`${locale}:${id}`) ? [catalog.get(`${locale}:${id}`)!] : []).reverse(),
  };
  const lock = {
    acquire: async (key: string) => {
      if (leases.has(key)) return null;
      leases.set(key, 'lease');
      return 'lease';
    },
    release: async (key: string) => { leases.delete(key); },
  };
  return { snapshots, catalog, calls, store, source, lock, leases,
    fetch: (fn: typeof fetcher) => { fetcher = fn; },
    service: (media: MediaTrendingKind) => new MediaTrendingService(media, store, source, lock, { ttlSeconds }),
  };
}

for (const media of ['movie', 'tv'] as const) {
  test(`${media}: miss saves summaries before publication; hit preserves ID order without TMDB`, async () => {
    const f = fixture();
    const service = f.service(media);
    const first = await service.page(1, 'zh-CN', 'owner');
    const second = await service.page(1, 'zh-CN', 'owner');
    assert.deepEqual(second.items.map((item) => item.tmdbId), [1, 2]);
    assert.equal(second.generation, first.generation);
    assert.deepEqual(f.calls, ['fetch:1:zh-CN', 'save', 'publish']);
    assert.ok(f.snapshots.get(`${media}:zh-CN`)!.expiresAt - Date.now() <= 900000);
    assert.equal(JSON.stringify(f.snapshots.get(`${media}:zh-CN`)).includes('title'), false);
  });

  test(`${media}: expiry refetches first page and rejects old pagination without TMDB`, async () => {
    const f = fixture();
    const service = f.service(media);
    const first = await service.page(1, 'en-US', 'owner');
    f.snapshots.get(`${media}:en-US`)!.expiresAt = Date.now() - 1;
    await assert.rejects(service.page(2, 'en-US', 'owner', first.generation), { code: 'MEDIA_TRENDING_EXPIRED' });
    assert.equal(f.calls.filter((call) => call.startsWith('fetch')).length, 1);
    const fresh = await service.page(1, 'en-US', 'owner');
    assert.notEqual(fresh.generation, first.generation);
    assert.equal(f.calls.filter((call) => call.startsWith('fetch')).length, 2);
  });

  test(`${media}: pagination pins version, rejects skips, deduplicates/refills and retains overflow`, async () => {
    const f = fixture();
    f.fetch(async (page, locale) => ({ items: ({ 1: [1, 2], 2: [2, 3], 3: [4, 5] }[page] ?? []).map((id) => ({ tmdbId: id, title: locale })), page, totalPages: 3, totalResults: 6 }));
    const service = f.service(media);
    await assert.rejects(service.page(2, 'en-US', 'owner'), { code: 'MEDIA_TRENDING_EXPIRED' });
    const first = await service.page(1, 'en-US', 'owner');
    const expiresAt = f.snapshots.get(`${media}:en-US`)!.expiresAt;
    await assert.rejects(service.page(3, 'en-US', 'owner', first.generation), { code: 'MEDIA_TRENDING_EXPIRED' });
    const second = await service.page(2, 'en-US', 'owner', first.generation);
    assert.deepEqual(second.items.map((item) => item.tmdbId), [3, 4]);
    assert.equal(second.hasMore, true);
    assert.equal(second.generation, first.generation);
    assert.equal(f.snapshots.get(`${media}:en-US`)!.expiresAt, expiresAt);
    const last = await service.page(3, 'en-US', 'owner', first.generation);
    assert.deepEqual(last.items.map((item) => item.tmdbId), [5]);
    assert.equal(last.hasMore, false);
    assert.equal((await service.page(1, 'en-US', 'owner')).hasMore, true);
    assert.equal(f.calls.filter((call) => call.startsWith('fetch')).length, 3);
  });

  test(`${media}: partial Mongo failure never publishes a list; lock released and later request retries`, async () => {
    const f = fixture();
    const failure = new Error('summary write failed');
    const save = f.source.save;
    f.source.save = async () => {
      throw failure;
    };
    await assert.rejects(f.service(media).page(1, 'zh-CN', 'owner'), (error: unknown) => (error as Error).cause === failure);
    assert.equal(f.snapshots.size, 0);
    assert.equal(f.leases.size, 0);
    f.source.save = save;
    assert.equal((await f.service(media).page(1, 'zh-CN', 'owner')).items.length, 2);
  });
}

test('media and locale lists are independent; concurrent misses do not duplicate fetches', async () => {
  const f = fixture();
  let unblock!: () => void;
  const pending = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  const fetch = f.source.fetch;
  f.source.fetch = async (...args) => {
    await pending;
    return fetch(...args);
  };
  const first = f.service('movie').page(1, 'en-US', 'owner');
  // Wait for the first request's lock, without timing-based sleeps.
  while (f.leases.size === 0) await new Promise<void>((resolve) => setImmediate(resolve));
  await assert.rejects(f.service('movie').page(1, 'en-US', 'owner'), { statusCode: 409 });
  unblock();
  await first;
  await f.service('movie').page(1, 'zh-CN', 'owner');
  await f.service('tv').page(1, 'en-US', 'owner');
  assert.equal(f.snapshots.size, 3);
  assert.deepEqual([...f.snapshots.keys()].sort(), ['movie:en-US', 'movie:zh-CN', 'tv:en-US']);
});

test('TMDB failure after expiry never serves obsolete Mongo lists or stale Redis generations', async () => {
  const f = fixture();
  const service = f.service('tv');
  await service.page(1, 'en-US', 'owner');
  f.snapshots.get('tv:en-US')!.expiresAt = Date.now() - 1;
  const failure = new Error('TMDB unavailable');
  f.fetch(async () => {
    throw failure;
  });
  await assert.rejects(service.page(1, 'en-US', 'owner'), (error: unknown) => (error as Error).cause === failure);
  assert.equal(f.catalog.size, 2);
  assert.equal(f.leases.size, 0);
});

test('diagnostics preserve request correlation, failed stage and cause with verbose disabled', async () => {
  const f = fixture();
  const failure = new Error('upstream failed');
  f.fetch(async () => {
    throw failure;
  });
  const logs: Record<string, unknown>[] = [];
  const trace = new AiTrace({
    info: (fields: object) => {
      logs.push({ ...fields, level: 'info' });
    },
    error: (fields: object) => {
      logs.push({ ...fields, level: 'error' });
    },
  }, { requestId: 'request-42' }, '', 'movie.trending', false);
  await assert.rejects(withAiTrace(trace, () => f.service('movie').page(1, 'en-US', 'owner')));
  assert.equal(logs.length, 1);
  assert.equal(logs[0]!.correlationId, 'request-42');
  assert.equal(logs[0]!.stage, 'media.trending.tmdb.fetch');
  assert.match(JSON.stringify(logs[0]!.error), /upstream failed/);
});
