import assert from 'node:assert/strict';
import test from 'node:test';
import type { MovieReleaseListResponse } from '@movie-hub/contract';
import { MovieReleaseCacheService } from './movie-release-cache.service.js';
import type { MovieReleaseCacheEntry, MovieReleaseCacheIdentity, MovieReleaseCacheStore } from './movie-release-cache.types.js';
import { isMTeamReleaseCacheValue } from './movie-release-cache.schema.js';
import { MovieReleaseCacheError } from './movie-release-cache.errors.js';

class FakeCacheStore implements MovieReleaseCacheStore {
  now = Date.now();
  failWrites = false;
  readonly rows = new Map<string, MovieReleaseCacheEntry>();
  readonly revisions = new Map<string, { value: string; expiresAt: number }>();

  async read(key: string) {
    const entry = this.rows.get(key);
    return entry && Date.parse(entry.expiresAt) > this.now ? entry : null;
  }

  async write(key: string, value: unknown, ttlMs: number) {
    if (this.failWrites) throw new Error('Redis write failed');
    const expiresAt = new Date(this.now + ttlMs).toISOString();
    this.rows.set(key, { value, expiresAt });
    return expiresAt;
  }

  async readRevision(scopeKey: string) {
    const entry = this.revisions.get(scopeKey);
    return entry && entry.expiresAt > this.now ? entry.value : null;
  }

  async activateRevision(scopeKey: string, revision: string, ttlMs: number) {
    this.revisions.set(scopeKey, { value: revision, expiresAt: this.now + ttlMs });
  }
}

const identity: MovieReleaseCacheIdentity = {
  ownerId: 'alice', tmdbId: 603, site: 'mteam', page: 1, locale: 'zh-CN', credentialVersion: 'v1',
};

function release(id: string): MovieReleaseListResponse {
  return {
    provider: 'mteam', availability: 'available', queriedAt: '2026-10-25T00:00:00.000Z', cached: false,
    releases: [{ id, title: `Release ${id}`, detailsUrl: `https://example.test/detail/${id}`, seeders: 1, tags: [] }],
  };
}

test('shared cache reads once, isolates owners and credentials, and expires after the configured TTL', async () => {
  const store = new FakeCacheStore();
  const cache = new MovieReleaseCacheService(store, 1_800_000);
  let calls = 0;
  const fetch = async () => {
    calls += 1;
    return release(String(calls));
  };
  const query = (key: MovieReleaseCacheIdentity) => ({ identity: key, validate: isMTeamReleaseCacheValue, fetch });

  const first = await cache.getOrFetch(query(identity));
  assert.equal(first.cached, false);
  assert.equal(first.cacheExpiresAt, new Date(store.now + 1_800_000).toISOString());
  assert.equal((await cache.getOrFetch(query(identity))).cached, true);
  const secondInstance = new MovieReleaseCacheService(store, 1_800_000);
  assert.equal((await secondInstance.getOrFetch(query(identity))).cached, true);
  assert.equal(calls, 1);
  await cache.getOrFetch(query({ ...identity, ownerId: 'bob' }));
  await cache.getOrFetch(query({ ...identity, site: 'hdarea' }));
  await cache.getOrFetch(query({ ...identity, credentialVersion: 'v2' }));
  assert.equal(calls, 4);
  store.now += 1_800_001;
  assert.equal((await cache.getOrFetch(query(identity))).cached, false);
  assert.equal(calls, 5);
});

test('forced refresh replaces only a successful result and coalesces concurrent refreshes', async () => {
  const store = new FakeCacheStore();
  const cache = new MovieReleaseCacheService(store, 1_800_000);
  const query = (fetch: () => Promise<MovieReleaseListResponse>, force = false) => ({
    identity, validate: isMTeamReleaseCacheValue, fetch, force,
  });
  await cache.getOrFetch(query(async () => release('old')));
  await assert.rejects(cache.getOrFetch(query(async () => {
    throw new Error('site failed');
  }, true)), /site failed/);
  assert.equal((await cache.getOrFetch(query(async () => release('unused')))).releases[0]?.id, 'old');
  store.failWrites = true;
  await assert.rejects(cache.getOrFetch(query(async () => release('unwritten'), true)), MovieReleaseCacheError);
  store.failWrites = false;
  assert.equal((await cache.getOrFetch(query(async () => release('unused')))).releases[0]?.id, 'old');

  let resolve!: (value: MovieReleaseListResponse) => void;
  let signalStarted!: () => void;
  const started = new Promise<void>((done) => {
    signalStarted = done;
  });
  let calls = 0;
  const fetch = () => {
    calls += 1;
    signalStarted();
    return new Promise<MovieReleaseListResponse>((done) => {
      resolve = done;
    });
  };
  const first = cache.getOrFetch(query(fetch, true));
  const second = cache.getOrFetch(query(fetch, true));
  await started;
  resolve(release('new'));
  assert.equal((await first).releases[0]?.id, 'new');
  assert.equal((await second).releases[0]?.id, 'new');
  assert.equal(calls, 1);
  assert.equal((await cache.getOrFetch(query(async () => release('unused')))).releases[0]?.id, 'new');
});

test('refreshing the first page invalidates cached later pages for the same user and site', async () => {
  const store = new FakeCacheStore();
  const cache = new MovieReleaseCacheService(store, 1_800_000);
  const query = (page: number, id: string, force = false) => ({
    identity: { ...identity, page }, validate: isMTeamReleaseCacheValue,
    fetch: async () => release(id), force,
  });
  await cache.getOrFetch(query(1, 'old-first'));
  await cache.getOrFetch(query(2, 'old-second'));
  assert.equal((await cache.getOrFetch(query(2, 'unused'))).cached, true);

  await cache.getOrFetch(query(1, 'new-first', true));
  const secondPage = await cache.getOrFetch(query(2, 'new-second'));
  assert.equal(secondPage.cached, false);
  assert.equal(secondPage.releases[0]?.id, 'new-second');
});
