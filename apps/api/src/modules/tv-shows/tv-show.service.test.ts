import assert from 'node:assert/strict';
import test from 'node:test';
import { TvShowService } from './tv-show.service.js';
import { TvSeasonService } from './tv-season.service.js';
import { TmdbHttpError } from '../../infrastructure/tmdb/tmdb-http.client.js';
import type { TvShowCatalogStore, TvShowProvider, TvShowRecord } from './tv-show.types.js';
import type { TvSeasonRecord, TvSeasonStore } from './tv-season.types.js';
import type { TvSyncLock } from './tv-show.types.js';

const show: TvShowRecord = { mediaType: 'tv', tmdbId: 42, name: 'Series', genreIds: [], seasons: [] };
const season: TvSeasonRecord = { tmdbId: 99, tvShowTmdbId: 42, name: 'Season', seasonNumber: 1, episodes: [], episodeCount: 0 };
const lock: TvSyncLock = { acquire: async () => 'owner', release: async () => {
} };
function catalog(cached: TvShowRecord | null = null): TvShowCatalogStore {
  return { readDetail: async () => cached, writeDetail: async () => {
  }, readSummaries: async () => [], upsertSummaries: async () => {
  } };
}
function provider(): TvShowProvider {
  return { search: async (_query, page) => ({ items: [show], page, totalPages: 3, totalResults: 50 }), fetchDetail: async () => show, fetchTrending: async (page) => ({ items: [show], page, totalPages: 3, totalResults: 50 }) };
}
function seasons(cached: TvSeasonRecord | null = null): TvSeasonStore {
  return { readDetail: async () => cached, readSummaries: async () => [], writeSummaries: async () => {
  }, writeDetail: async () => {
  } };
}
test('fresh detail uses locale cache without TMDB; missing counts remain unknown', async () => {
  const upstream = provider();
  upstream.fetchDetail = async () => {
    throw new Error('must not fetch');
  };
  const result = await new TvShowService(catalog({ ...show, syncedAt: new Date(), trailerSyncedAt: new Date(), taglineSyncedAt: new Date() }), upstream, lock).detail(42, 'zh-CN', null);
  assert.equal(result.stale, false);
  assert.equal(result.locale, 'zh-CN');
  assert.equal(result.numberOfSeasons, undefined);
});
test('new detail passes locale/owner, persists before returning and emits image URLs', async () => {
  let saved = false;
  const store = catalog();
  store.writeDetail = async (_show, locale) => {
    assert.equal(locale, 'en-US');
    saved = true;
  };
  const upstream = provider();
  upstream.fetchDetail = async (_id, locale, context) => {
    assert.equal(locale, 'en-US');
    assert.equal(context.ownerId, 'user-a');
    return { ...show, posterPath: '/p.jpg' };
  };
  const result = await new TvShowService(store, upstream, lock).detail(42, 'en-US', 'user-a');
  assert.ok(saved);
  assert.match(result.posterUrl!, /image.tmdb.org/);
  assert.equal(result.stale, false);
});
test('TMDB failure returns stale cached detail; no cache preserves original cause and maps 404', async () => {
  const failure = new TmdbHttpError(404);
  const upstream = provider();
  upstream.fetchDetail = async () => {
    throw failure;
  };
  const result = await new TvShowService(catalog({ ...show, syncedAt: new Date(0) }), upstream, lock).detail(42, 'en-US', null);
  assert.equal(result.stale, true);
  await assert.rejects(new TvShowService(catalog(), upstream, lock).detail(42, 'zh-CN', null), (error: unknown) => {
    assert.equal((error as {
      statusCode: number;
    }).statusCode, 404);
    assert.equal((error as Error).cause, failure);
    assert.match((error as Error).message, /未找到/);
    return true;
  });
});
test('season partial persistence never reports success and distributed lock is released', async () => {
  const failure = new Error('write failed');
  const store = seasons();
  let released = false;
  store.writeDetail = async () => {
    throw failure;
  };
  const service = new TvSeasonService(store, { fetchSeason: async () => season }, { ...lock, release: async () => {
    released = true;
  } });
  await assert.rejects(service.detail(42, 1, 'en-US', null), (error: unknown) => (error as Error).cause === failure);
  assert.ok(released);
});
test('season lock contention returns cached stale data or explicit conflict', async () => {
  const busy = { ...lock, acquire: async () => null };
  const upstream = { fetchSeason: async () => {
    throw new Error('must not fetch');
  } };
  const result = await new TvSeasonService(seasons({ ...season, syncedAt: new Date(0) }), upstream, busy).detail(42, 1, 'en-US', null);
  assert.equal(result.stale, true);
  await assert.rejects(new TvSeasonService(seasons(), upstream, busy).detail(42, 1, 'en-US', null), (e: unknown) => (e as {
    statusCode: number;
  }).statusCode === 409);
});
test('TV search trims input, attributes requests and saves only show summaries', async () => {
  const store = catalog();
  let saved: TvShowRecord[] = [];
  store.upsertSummaries = async (items, locale) => {
    assert.equal(locale, 'zh-CN');
    saved = items;
  };
  const upstream = provider();
  upstream.search = async (query, page, locale, context) => {
    assert.equal(query, 'The Bear');
    assert.equal(page, 2);
    assert.equal(locale, 'zh-CN');
    assert.equal(context.ownerId, 'user-a');
    return { items: [show], page, totalPages: 3, totalResults: 50 };
  };
  const service = new TvShowService(store, upstream, lock);
  const result = await service.search('  The Bear  ', 2, 'zh-CN', 'user-a');
  assert.equal(result.hasMore, true);
  assert.equal(result.items[0]?.mediaType, 'tv');
  assert.deepEqual(saved, [show]);
  assert.ok(!('generation' in result));
});

test('TV search rejects blank/oversized queries and invalid pages, preserving upstream failure causes', async () => {
  const upstream = provider();
  const service = new TvShowService(catalog(), upstream, lock);
  for (const [query, page] of [['   ', 1], ['a'.repeat(101), 1], ['valid', 0], ['valid', 51]] as const) {
    await assert.rejects(service.search(query, page, 'en-US', null), (error: unknown) => (error as { statusCode: number }).statusCode === 400);
  }
  const failure = new Error('network failed');
  upstream.search = async () => {
    throw failure;
  };
  await assert.rejects(service.search('Series', 1, 'en-US', null), (error: unknown) => {
    assert.equal((error as Error).cause, failure);
    return (error as { statusCode: number }).statusCode === 503;
  });
});

test('legacy fresh TV detail without a video marker refreshes once and returns trailer metadata', async () => {
  const trailer = { tmdbVideoId: 'video', provider: 'youtube' as const, providerVideoId: 'Safe_video-1', name: 'Trailer', official: true };
  const cached = { ...show, syncedAt: new Date() };
  let fetched = false;
  const upstream = provider();
  upstream.fetchDetail = async () => {
    fetched = true;
    return { ...show, trailer };
  };
  const result = await new TvShowService(catalog(cached), upstream, lock).detail(42, 'en-US', 'owner');
  assert.equal(fetched, true);
  assert.deepEqual(result.trailer, trailer);
});

test('legacy detail refreshes tagline once, including a known empty tagline', async () => {
  let cached: TvShowRecord = { ...show, syncedAt: new Date(), trailerSyncedAt: new Date() };
  const store = catalog();
  store.readDetail = async () => cached;
  store.writeDetail = async (record, _locale, now) => {
    cached = { ...record, syncedAt: now, trailerSyncedAt: now, taglineSyncedAt: now };
  };
  let calls = 0;
  const upstream = provider();
  upstream.fetchDetail = async () => {
    ++calls;
    return show;
  };
  const service = new TvShowService(store, upstream, lock);
  assert.equal((await service.detail(42, 'en-US', null)).tagline, undefined);
  assert.equal((await service.detail(42, 'en-US', null)).tagline, undefined);
  assert.equal(calls, 1);
  cached = { ...cached, tagline: 'The truth awaits' };
  assert.equal((await service.detail(42, 'en-US', null)).tagline, 'The truth awaits');
  assert.equal(calls, 1);
});
