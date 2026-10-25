import assert from 'node:assert/strict';
import test from 'node:test';
import { RedisMediaTrendingStore } from './media-trending.store.js';
import type { MediaTrendingSnapshot } from '../../modules/media-trending/media-trending.schema.js';

const snapshot = (): MediaTrendingSnapshot => ({ generation: '00000000-0000-4000-8000-000000000001', fetchedAt: new Date().toISOString(), expiresAt: Date.now() + 900000, sourcePage: 1, pageSize: 2, totalPages: 2, totalResults: 4, pages: [[1, 2]], pendingIds: [] });

test('invalid, expired and absent Redis values are cache misses; media/locale keys are isolated', async () => {
  let raw: string | null = null;
  const keys: string[] = [];
  const store = new RedisMediaTrendingStore({ get: async (key: string) => {
    keys.push(key);
    return raw;
  } } as never);
  for (const value of [null, 'broken', '{}', JSON.stringify({ ...snapshot(), expiresAt: Date.now() - 1 })]) {
    raw = value;
    assert.equal(await store.read('movie', 'en-US'), null);
  }
  raw = JSON.stringify(snapshot());
  assert.deepEqual((await store.read('movie', 'zh-CN'))?.pages, [[1, 2]]);
  await store.read('tv', 'en-US');
  assert.equal(new Set(keys).size, 3);
});

test('publishes atomically under lock ownership with remaining TTL, never a renewed full TTL', async () => {
  const args: unknown[][] = [];
  const store = new RedisMediaTrendingStore({ eval: async (...input: unknown[]) => {
    args.push(input);
    return 1;
  } } as never);
  const record = { ...snapshot(), expiresAt: Date.now() + 2000 };
  await store.write('movie', 'en-US', record, { key: 'lock:key', owner: 'owner' });
  assert.equal(args[0]![1], 2);
  assert.equal(args[0]![2], 'media-trending:v1:movie:week:en-US');
  assert.equal(args[0]![3], 'lock:key');
  assert.equal(args[0]![4], 'owner');
  assert.deepEqual(JSON.parse(args[0]![5] as string).pages, [[1, 2]]);
  assert.ok(Number(args[0]![6]) > 0 && Number(args[0]![6]) <= 2000);
  assert.match(String(args[0]![0]), /GET.*KEYS\[2\]/);
});

test('lost lease or already expired snapshot cannot publish', async () => {
  let writes = 0;
  const store = new RedisMediaTrendingStore({ eval: async () => {
    writes++;
    return 0;
  } } as never);
  await assert.rejects(store.write('tv', 'zh-CN', snapshot(), { key: 'lock', owner: 'owner' }), /lost its lock/);
  await assert.rejects(store.write('tv', 'zh-CN', { ...snapshot(), expiresAt: Date.now() - 1 }, { key: 'lock', owner: 'owner' }), /expired/);
  assert.equal(writes, 1);
});
