import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { Redis } from 'ioredis';
import { RedisMovieReleaseCacheStore, RedisResourceRefreshStore } from './movie-release-cache.store.js';

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

const socket = process.env.RESOURCE_REFRESH_TEST_SOCKET;
test('Redis refresh quota is atomic across clients and expires without extending rejected requests', { skip: !socket }, async () => {
  const first = new Redis(socket!, { retryStrategy: null });
  const second = new Redis(socket!, { retryStrategy: null });
  try {
    const stores = [new RedisResourceRefreshStore(first), new RedisResourceRefreshStore(second)];
    const owner = `test-${Date.now()}`;
    const results = await Promise.all(Array.from({ length: 40 }, (_, index) => stores[index % 2]!.claim(owner, 'mteam', 30_000)));
    assert.equal(results.filter((remaining) => remaining === 0).length, 1);
    assert.equal(results.filter((remaining) => remaining > 29_000 && remaining <= 30_000).length, 39);
    assert.equal(await stores[0]!.claim(`${owner}-other`, 'mteam', 30_000), 0);
    assert.equal(await stores[1]!.claim(owner, 'hdarea', 30_000), 0);
    assert.equal(await stores[0]!.claim(`${owner}-expiry`, 'mteam', 30), 0);
    await setTimeout(45);
    assert.equal(await stores[1]!.claim(`${owner}-expiry`, 'mteam', 30), 0);
  } finally {
    await Promise.all([first.quit(), second.quit()]);
  }
});
