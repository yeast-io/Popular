import assert from 'node:assert/strict';
import test from 'node:test';
import type { MovieReleaseCacheEntry, MovieReleaseCacheStore, ResourceRefreshStore } from '../integrations/movie-release-cache.types.js';
import { MovieReleaseCacheService } from '../integrations/movie-release-cache.service.js';
import { ResourceSearchService } from './resource-search.service.js';

function fixture() {
  let now = Date.now();
  let version = 'v1';
  let calls = 0;
  let fail = false;
  const rows = new Map<string, MovieReleaseCacheEntry>();
  const revisions = new Map<string, string>();
  const deadlines = new Map<string, number>();
  const store: MovieReleaseCacheStore = {
    async read(key) {
      const row = rows.get(key);
      return row && Date.parse(row.expiresAt) > now ? row : null;
    },
    async write(key, value, ttlMs) {
      const expiresAt = new Date(now + ttlMs).toISOString();
      rows.set(key, { value, expiresAt });
      return expiresAt;
    },
    async readRevision(key) { return revisions.get(key) ?? null; },
    async activateRevision(key, revision) { revisions.set(key, revision); },
  };
  const limiter: ResourceRefreshStore = {
    async claim(owner, site, interval) {
      const key = `${owner}:${site}`;
      const remaining = Math.max(0, (deadlines.get(key) ?? 0) - now);
      if (!remaining) deadlines.set(key, now + interval);
      return remaining;
    },
  };
  const createCache = () => new MovieReleaseCacheService(store, 1_800_000, limiter);
  const createService = () => new ResourceSearchService(['mteam', 'hdarea'].map((id) => ({
    id, name: id, details: false, status: async () => 'configured_valid' as const,
    search: async () => {
      calls += 1;
      if (fail) throw new Error('Source failed');
      return { releases: [{ id: String(calls), title: 'Show', detailsUrl: `https://source.example/detail/${calls}` }], nextPage: 2 };
    },
  })), async () => ['mteam', 'hdarea'], { cache: createCache(), credentialVersion: async () => version });
  return {
    createCache, createService, calls: () => calls,
    expire: (ms: number) => { now += ms; },
    credentialsChanged: () => { version = 'v2'; },
    fail: (value: boolean) => { fail = value; },
  };
}
const input = { mediaType: 'tv' as const, query: 'Show S01' };
const signal = () => new AbortController().signal;

test('TV restoration reads only Redis, shares cached results across instances and respects TTL', async () => {
  const f = fixture();
  const first = f.createService();
  const second = f.createService();
  assert.equal((await first.search('alice', 'mteam', { ...input, cacheOnly: true }, signal())).cacheMiss, true);
  assert.equal(f.calls(), 0);
  const fresh = await first.search('alice', 'mteam', input, signal());
  assert.equal(fresh.cached, false);
  const restored = await second.search('alice', 'mteam', { ...input, cacheOnly: true }, signal());
  assert.equal(restored.cached, true);
  assert.equal(restored.queriedAt, fresh.queriedAt);
  assert.equal(f.calls(), 1);
  f.expire(1_800_001);
  assert.equal((await second.search('alice', 'mteam', { ...input, cacheOnly: true }, signal())).cacheMiss, true);
  assert.equal(f.calls(), 1);
  await second.search('alice', 'mteam', input, signal());
  assert.equal(f.calls(), 2);
});

test('TV cache isolates users, sites, seasons, pages, locale and credential revisions', async () => {
  const f = fixture();
  const service = f.createService();
  await service.search('alice', 'mteam', input, signal());
  await service.search('bob', 'mteam', input, signal());
  await service.search('alice', 'hdarea', input, signal());
  await service.search('alice', 'mteam', { ...input, query: 'Show S02' }, signal());
  await service.search('alice', 'mteam', { ...input, page: 2 }, signal());
  await service.search('alice', 'mteam', input, signal(), 'zh-CN');
  f.credentialsChanged();
  await service.search('alice', 'mteam', input, signal());
  assert.equal(f.calls(), 7);
});

test('refresh bypasses cache, invalidates old pages and enforces a shared 30-second quota', async () => {
  const f = fixture();
  const first = f.createService();
  const second = f.createService();
  await first.search('alice', 'mteam', input, signal());
  await first.search('alice', 'mteam', { ...input, page: 2 }, signal());
  const refreshed = await first.search('alice', 'mteam', { ...input, refresh: true }, signal());
  assert.equal(refreshed.cached, false);
  await assert.rejects(second.search('alice', 'mteam', { ...input, query: 'Other S02', refresh: true }, signal()),
    { statusCode: 429, code: 'RESOURCE_REFRESH_RATE_LIMITED', details: { retryAfterSeconds: 30 } });
  assert.equal(f.calls(), 3);
  assert.equal((await second.search('alice', 'mteam', { ...input, page: 2, cacheOnly: true }, signal())).cacheMiss, true);
  await second.search('bob', 'mteam', { ...input, refresh: true }, signal());
  await second.search('alice', 'hdarea', { ...input, refresh: true }, signal());
  f.expire(30_000);
  await second.search('alice', 'mteam', { ...input, refresh: true }, signal());
  assert.equal(f.calls(), 6);
});

test('movie refresh and TV refresh share the same user/site quota', async () => {
  const f = fixture();
  const cache = f.createCache();
  await cache.getOrFetch({
    identity: { ownerId: 'alice', site: 'mteam', tmdbId: 42, page: 1, locale: 'en-US', credentialVersion: 'v1' },
    force: true, validate: (value): value is { cached: boolean } => typeof value === 'object' && value !== null && 'cached' in value,
    fetch: async () => ({ cached: false }),
  });
  await assert.rejects(f.createService().search('alice', 'mteam', { ...input, refresh: true }, signal()), { code: 'RESOURCE_REFRESH_RATE_LIMITED' });
  assert.equal(f.calls(), 0);
});

test('a failed refresh preserves the previous cache without releasing the rate limit', async () => {
  const f = fixture();
  const service = f.createService();
  const original = await service.search('alice', 'mteam', input, signal());
  f.fail(true);
  await assert.rejects(service.search('alice', 'mteam', { ...input, refresh: true }, signal()), /Source failed/);
  f.fail(false);
  const restored = await service.search('alice', 'mteam', { ...input, cacheOnly: true }, signal());
  assert.deepEqual(restored.releases, original.releases);
  await assert.rejects(service.search('alice', 'mteam', { ...input, refresh: true }, signal()), { code: 'RESOURCE_REFRESH_RATE_LIMITED' });
  assert.equal(f.calls(), 2);
});
