import assert from 'node:assert/strict';
import test from 'node:test';
import { WatchlistService } from './watchlist.service.js';
import type { TvWatchlistStore } from './watchlist.types.js';
import type { TvShowCatalogStore } from '../tv-shows/tv-show.types.js';
import type { MovieStatusService } from '../movie-statuses/movie-status.service.js';

function setup() {
  const entries = new Map<string, number[]>();
  const calls: unknown[][] = [];
  const notifications = new Set<string>();
  const tv: TvWatchlistStore = {
    contains: async (owner, id) => (entries.get(owner) ?? []).includes(id),
    add: async (owner, id) => { entries.set(owner, [...new Set([...(entries.get(owner) ?? []), id])]); },
    remove: async (owner, id) => { entries.set(owner, (entries.get(owner) ?? []).filter((value) => value !== id)); },
    setResourceNotification: async (owner, id, enabled) => {
      if (!(entries.get(owner) ?? []).includes(id)) return false;
      if (enabled) notifications.add(`${owner}:${id}`);
      else notifications.delete(`${owner}:${id}`);
      return true;
    },
    list: async (owner, page, size) => ({ notificationEnabledIds: (entries.get(owner) ?? []).filter((id) => notifications.has(`${owner}:${id}`)), ids: (entries.get(owner) ?? []).slice((page - 1) * size, page * size), total: (entries.get(owner) ?? []).length }),
  };
  const catalog: TvShowCatalogStore = {
    readDetail: async () => null,
    readSummaries: async (ids, locale) => ids.filter((id) => id !== 404).reverse().map((tmdbId) => ({ mediaType: 'tv', tmdbId, name: locale === 'zh-CN' ? `剧集${tmdbId}` : `Series ${tmdbId}`, genreIds: [], posterPath: '/poster.jpg', firstAirDate: '2020-01-01', overview: 'Overview' })),
    writeDetail: async () => {},
    upsertSummaries: async () => {},
  };
  const movies = { list: async (...args: unknown[]) => {
    calls.push(args);
    return { items: [{ tmdbId: 42, title: 'Movie', userStatus: 'interested', userPreference: 'neutral', resourceCheck: { checking: false } }], pagination: { page: 2, pageSize: 20, total: 30, hasMore: false }, locale: 'en-US' };
  } } as unknown as MovieStatusService;
  return { entries, service: new WatchlistService(movies, catalog, tv, { setResourceNotification: async (...args) => {
    calls.push(args);
    return args[0] === 'owner' && args[1] === 42;
  }, list: async () => ({ items: [{ tmdbId: 42, ownerId: 'owner', status: 'interested' as const, preference: 'neutral' as const, updatedAt: new Date() }], total: 30 }) }), calls };
}

test('movie watch list retains interested resource-check path and excludes status/action metadata', async () => {
  const { service, calls } = setup();
  const result = await service.list('owner', 'movie', 2, 20, 'en-US');
  assert.deepEqual(calls, [['owner', 'interested', 2, 20, 'en-US']]);
  assert.deepEqual(result.items, [{ mediaType: 'movie', tmdbId: 42, resourceNotificationEnabled: false, title: 'Movie' }]);
  assert.equal(result.pagination.total, 30);
});
test('TV membership is owner-scoped, idempotent and independent of movie IDs', async () => {
  const { service } = setup();
  await service.addTv('one', 42, 'en-US');
  await service.addTv('one', 42, 'en-US');
  assert.deepEqual(await service.membership('one', 42), { inWatchlist: true });
  assert.deepEqual(await service.membership('two', 42), { inWatchlist: false });
  assert.equal((await service.list('one', 'tv', 1, 20, 'en-US')).pagination.total, 1);
  await service.removeTv('two', 42);
  assert.equal((await service.membership('one', 42)).inWatchlist, true);
  await service.removeTv('one', 42);
  await service.removeTv('one', 42);
  assert.equal((await service.membership('one', 42)).inWatchlist, false);
});
test('TV listing preserves saved order, paginates and localizes catalog summaries', async () => {
  const { service } = setup();
  for (const id of [1, 2, 3]) await service.addTv('one', id, 'zh-CN');
  const result = await service.list('one', 'tv', 1, 2, 'zh-CN');
  assert.deepEqual(result.items.map((item) => item.tmdbId), [1, 2]);
  assert.equal(result.items[0]?.title, '剧集1');
  assert.equal(result.items[0]?.posterUrl, 'https://image.tmdb.org/t/p/w500/poster.jpg');
  assert.equal(result.items[0]?.releaseDate, '2020-01-01');
  assert.deepEqual(result.pagination, { page: 1, pageSize: 2, total: 3, hasMore: true });
  assert.deepEqual((await service.list('one', 'tv', 2, 2, 'en-US')).items.map((item) => item.tmdbId), [3]);
});
test('TV additions reject unknown catalog IDs without saving membership', async () => {
  const { service } = setup();
  await assert.rejects(service.addTv('one', 404, 'zh-CN'), /未找到/);
  assert.equal((await service.membership('one', 404)).inWatchlist, false);
});

test('saved TV IDs remain visible when all localized catalog metadata is unavailable', async () => {
  const { service, entries } = setup();
  entries.set('one', [404]);
  const result = await service.list('one', 'tv', 1, 20, 'zh-CN');
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0]?.tmdbId, 404);
  assert.equal(result.items[0]?.title, '资料暂不可用 · TMDB 404');
  assert.equal(result.pagination.total, 1);
});

test('notification switches persist independently of membership, owner and media type', async () => {
  const { service, calls } = setup();
  await service.addTv('one', 42, 'en-US');
  assert.equal((await service.list('one', 'tv', 1, 20, 'en-US')).items[0]?.resourceNotificationEnabled, false);
  assert.deepEqual(await service.setResourceNotification('one', 'tv', 42, true, 'en-US'), { enabled: true });
  assert.equal((await service.list('one', 'tv', 1, 20, 'en-US')).items[0]?.resourceNotificationEnabled, true);
  assert.equal((await service.membership('one', 42)).inWatchlist, true);
  await assert.rejects(service.setResourceNotification('two', 'tv', 42, true, 'zh-CN'), /想看清单/);
  await service.setResourceNotification('one', 'tv', 42, false, 'en-US');
  assert.equal((await service.list('one', 'tv', 1, 20, 'en-US')).items[0]?.resourceNotificationEnabled, false);
  await service.setResourceNotification('owner', 'movie', 42, true, 'en-US');
  assert.deepEqual(calls.pop(), ['owner', 42, true]);
  await assert.rejects(service.setResourceNotification('two', 'movie', 42, true, 'en-US'), /not in your watch list/);
});
