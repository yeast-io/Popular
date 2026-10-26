import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { once } from 'node:events';
import { Redis } from 'ioredis';
import { RedisEmailVerificationStore } from './email-verification.store.js';

// Run against a disposable Redis only; never use application data.
test('real Redis: atomic quota, email binding, expiry, attempts, claims and replay protection', {
  skip: !process.env.POPULAR_VERIFICATION_REDIS_SERVER,
  timeout: 15000,
}, async () => {
  const directory = await mkdtemp('/tmp/popular-verification-');
  const socket = join(directory, 'redis.sock');
  const server = spawn(process.env.POPULAR_VERIFICATION_REDIS_SERVER!, ['--port', '0', '--unixsocket', socket, '--save', '', '--appendonly', 'no'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const redis = new Redis({ path: socket, keyPrefix: 'verification-test:', lazyConnect: true, retryStrategy: () => null });
  redis.on('error', () => undefined);
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Disposable Redis startup timed out')), 3000);
      server.stdout.on('data', (chunk: Buffer) => {
        if (/ready to accept connections/i.test(chunk.toString())) {
          clearTimeout(timer);
          resolve();
        }
      });
      server.once('error', reject);
    });
    await redis.connect();
    const store = new RedisEmailVerificationStore(redis);
    const otherProcess = new RedisEmailVerificationStore(redis);
    const payload = { email: 'person@example.com', displayName: 'Person', passwordHash: 'scrypt-hash', locale: 'zh-CN' as const, expiresAt: Date.now() + 86400000 };
    const reservations = await Promise.all(Array.from({ length: 110 }, (_, index) => {
      return (index % 2 ? store : otherProcess).reserve(String(index), `digest-${index}`, `reservation-${index}`, { ...payload, email: `${index}@example.com` });
    }));
    assert.equal(reservations.filter((result) => result.status === 'created').length, 100);
    assert.equal(reservations.filter((result) => result.status === 'limit').length, 10);
    assert.equal(await redis.zcard('registration:email:quota'), 100);
    assert.equal((await store.reserve('0', 'replaced-digest', 'replacement', payload)).status, 'existing');
    const ttl = await redis.ttl('registration:email:pending:0');
    assert.ok(ttl > 86390 && ttl <= 86400);
    assert.equal(await store.claim('missing', 'digest-0', 'claim-missing'), null);
    const concurrentClaims = await Promise.all([store.claim('0', 'digest-0', 'claim-a'), otherProcess.claim('0', 'digest-0', 'claim-b')]);
    assert.equal(concurrentClaims.filter(Boolean).length, 1);
    assert.equal(concurrentClaims[0]?.email, '0@example.com');
    await store.finish('0', 'wrong-owner', true);
    assert.equal(await redis.exists('registration:email:pending:0'), 1);
    await store.finish('0', 'claim-a', false);
    assert.ok(await store.claim('0', 'digest-0', 'claim-c'));
    await store.finish('0', 'claim-c', true);
    assert.equal(await store.claim('0', 'digest-0', 'replay'), null);
    // Verification and cancellation must not refund email sends.
    await store.cancel('1', 'wrong-reservation');
    assert.equal(await redis.exists('registration:email:pending:1'), 1);
    await store.cancel('1', 'reservation-1');
    assert.equal(await redis.exists('registration:email:pending:1'), 0);
    assert.equal((await store.reserve('new', 'digest-new', 'new', payload)).status, 'limit');
    for (let attempt = 0; attempt < 5; attempt++) assert.equal(await store.claim('2', 'wrong', 'wrong'), null);
    assert.equal(await store.claim('2', 'digest-2', 'locked'), null);
    // Expiry deletes both the email registration and code digest.
    await redis.pexpire('registration:email:pending:3', 1);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(await store.claim('3', 'digest-3', 'expired'), null);
    assert.equal(await redis.exists('registration:email:pending:3'), 0);
    // Rolling quota slots become available after 24 hours, not at midnight.
    await redis.zadd('registration:email:quota', Date.now() - 86401000, 'reservation-0');
    assert.equal((await store.reserve('new', 'digest-new', 'new', payload)).status, 'created');
    assert.equal(await redis.zcard('registration:email:quota'), 100);
    await redis.hset('registration:email:pending:new', 'claim', 'abandoned', 'claimUntil', '1');
    assert.ok(await store.claim('new', 'digest-new', 'recovery'));
  } finally {
    redis.disconnect();
    if (server.exitCode === null && server.signalCode === null) {
      const stopped = once(server, 'close');
      server.kill('SIGTERM');
      await stopped;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
