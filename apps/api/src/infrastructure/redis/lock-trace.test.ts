import assert from 'node:assert/strict';
import test from 'node:test';
import { RedisLockTrace } from './lock-trace.js';
import { RedisSyncLock } from './sync-lock.store.js';

function fixture(enabled: boolean, ttl: (key: string) => Promise<number> = async () => 42) {
  const logs: Array<Record<string, unknown>> = [];
  const logger = { info: (fields: Record<string, unknown>) => { logs.push(fields); }, error: (fields: Record<string, unknown>) => { logs.push(fields); } };
  return { logs, logger, trace: new RedisLockTrace(enabled, logger, ttl) };
}

test('disabled tracing preserves command results and errors without logs or TTL calls', async () => {
  const { trace, logs } = fixture(false, async () => assert.fail('must not inspect TTL when disabled'));
  assert.equal(await trace.run('acquire', ['lock'], async () => null), null);
  const error = new Error('Redis unavailable');
  await assert.rejects(trace.run('release', ['lock'], async () => { throw error; }), candidate => candidate === error);
  assert.deepEqual(logs, []);
});

test('busy, lost and non-owner results include TTL; inspection failure does not alter lock semantics', async () => {
  const { trace, logs } = fixture(true);
  assert.equal(await trace.run('acquire', ['lock'], async () => null), null);
  assert.equal(await trace.run('renew', ['lock'], async () => 0), 0);
  assert.equal(await trace.run('release', ['lock'], async () => 0), 0);
  for (const outcome of ['busy', 'lost', 'not_owned']) assert.ok(logs.some(line => line.outcome === outcome && (line.ttlSeconds as number[])[0] === 42));
  const failedTtl = fixture(true, async () => { throw new Error('TTL unavailable'); });
  assert.equal(await failedTtl.trace.run('acquire', ['lock'], async () => null), null);
  assert.ok(failedTtl.logs.some(line => line.stage === 'redis.lock.ttl.failed'));
});

test('trending sync traces acquire and release, while hiding ownership tokens', async () => {
  const { logger, logs } = fixture(true);
  const redis = { set: async () => 'OK', eval: async () => 1, ttl: async () => 42 };
  const lock = new RedisSyncLock(redis as never, true, logger);
  const owner = await lock.acquire('lock:sync:trending:movie:week:zh-CN:all', 300);
  assert.ok(owner);
  await lock.release('lock:sync:trending:movie:week:zh-CN:all', owner);
  assert.ok(logs.some(line => line.outcome === 'acquired' && line.leaseSeconds === 300 && line.lockType === 'trending_sync'));
  assert.ok(logs.some(line => line.outcome === 'released'));
  assert.ok(!JSON.stringify(logs).includes(owner));
  logs.length = 0;
  await new RedisSyncLock(redis as never, false, logger).acquire('lock', 300);
  assert.deepEqual(logs, []);
});

test('command failures retain safe error causes and do not consume the original exception', async () => {
  const { trace, logs } = fixture(true);
  const error = new Error('redis://user:private-password@redis.example failed', { cause: Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' }) });
  await assert.rejects(trace.run('renew', ['lock'], async () => { throw error; }), candidate => candidate === error);
  assert.match(JSON.stringify(logs), /ECONNREFUSED/);
  assert.ok(!JSON.stringify(logs).includes('private-password'));
});
