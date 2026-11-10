import assert from 'node:assert/strict';
import test from 'node:test';
import type { Redis } from 'ioredis';
import { RedisMovieReleaseCacheStore } from './movie-release-cache.store.js';

test('Redis release cache writes a bounded TTL and reads its expiry metadata', async () => {
  const values = new Map<string, string>();
  let expiryMs = 0;
  const redis = {
    async get(key: string) { return values.get(key) ?? null; },
    async set(key: string, value: string, mode: string, ttl: number) {
      assert.equal(mode, 'PX');
      expiryMs = ttl;
      values.set(key, value);
      return 'OK';
    },
    async del(key: string) {
      values.delete(key);
      return 1;
    },
  } as unknown as Redis;
  const store = new RedisMovieReleaseCacheStore(redis);
  const value = { cached: false, releases: [{ id: '42' }] };
  const expiresAt = await store.write('movie-releases:v1:abc', value, 1_800_000);
  assert.equal(expiryMs, 1_800_000);
  assert.deepEqual(await store.read('movie-releases:v1:abc'), { value, expiresAt });
  assert.equal(await store.read('movie-releases:v1:missing'), null);
  const revision = 'revised';
  await store.activateRevision('movie-releases:scope:v1:abc', revision, 3_600_000);
  assert.equal(await store.readRevision('movie-releases:scope:v1:abc'), revision);
  assert.equal(expiryMs, 3_600_000);
});
