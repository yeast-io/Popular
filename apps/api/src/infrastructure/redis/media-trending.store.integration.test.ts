import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { once } from 'node:events';
import { Redis } from 'ioredis';
import { RedisMediaTrendingStore } from './media-trending.store.js';
import { RedisSyncLock } from './sync-lock.store.js';

// Opt in to a disposable server on a Unix socket; never connect to application Redis.
test('real Redis: prefixed Lua publication enforces lease ownership and lists expire automatically', {
  skip: !process.env.POPULAR_TRENDING_REDIS_SERVER,
  timeout: 10000,
}, async () => {
  const directory = await mkdtemp('/tmp/popular-trending-');
  const socket = join(directory, 'redis.sock');
  const server = spawn(process.env.POPULAR_TRENDING_REDIS_SERVER!, ['--port', '0', '--unixsocket', socket, '--save', '', '--appendonly', 'no', '--logfile', ''], { stdio: ['ignore', 'pipe', 'pipe'] });
  const client = new Redis({ path: socket, keyPrefix: 'test-prefix:', lazyConnect: true, retryStrategy: () => null });
  client.on('error', () => undefined);
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Disposable Redis did not start within 3 seconds')), 3000);
      let output = '';
      server.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString();
        if (/ready to accept connections/i.test(output)) {
          clearTimeout(timer);
          resolve();
        }
      });
      server.once('error', reject);
      server.once('exit', (code) => reject(new Error(`Disposable Redis exited: ${code}`)));
    });
    await client.connect();
    const store = new RedisMediaTrendingStore(client);
    const locks = new RedisSyncLock(client);
    const lockKey = 'lock:media-trending:movie:week:en-US';
    const owner = await locks.acquire(lockKey, 10);
    assert.ok(owner);
    const record = { generation: '00000000-0000-4000-8000-000000000001', fetchedAt: new Date().toISOString(), expiresAt: Date.now() + 900000, sourcePage: 1, pageSize: 2, totalPages: 2, totalResults: 4, pages: [[1, 2]], pendingIds: [] };
    await store.write('movie', 'en-US', record, { key: lockKey, owner });
    assert.deepEqual((await store.read('movie', 'en-US'))?.pages, [[1, 2]]);
    assert.equal(await store.read('tv', 'en-US'), null);
    assert.equal(await store.read('movie', 'zh-CN'), null);
    const ttl = await client.pttl('media-trending:v1:movie:week:en-US');
    assert.ok(ttl > 890000 && ttl <= 900000);
    await locks.release(lockKey, owner);
    await assert.rejects(store.write('movie', 'en-US', { ...record, pages: [[9]] }, { key: lockKey, owner }), /lost its lock/);
    assert.deepEqual((await store.read('movie', 'en-US'))?.pages, [[1, 2]]);
    await client.pexpire('media-trending:v1:movie:week:en-US', 1);
    const deadline = Date.now() + 1000;
    while (await store.read('movie', 'en-US')) {
      assert.ok(Date.now() < deadline);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(await client.exists('media-trending:v1:movie:week:en-US'), 0);
  } finally {
    client.disconnect();
    if (server.exitCode === null && server.signalCode === null) {
      const stopped = once(server, 'close');
      server.kill('SIGTERM');
      await stopped;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
