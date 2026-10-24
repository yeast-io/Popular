import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { RedisRouter } from './redis-router.store.js';
import type { Session } from '../../gateway.types.js';

test(
  'REAL Redis: cross-instance routing, Pub/Sub wake, old cleanup, rate limit and expiry',
  {
    skip: !process.env.GATEWAY_TEST_REDIS_URL,
    timeout: 15_000,
  },
  async (t) => {
    const prefix = `gateway-test:${randomUUID()}:`;
    const redis1 = new Redis(process.env.GATEWAY_TEST_REDIS_URL!, {
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
    });
    const redis2 = new Redis(process.env.GATEWAY_TEST_REDIS_URL!, {
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
    });
    const one = new RedisRouter(redis1, prefix, 1000);
    const two = new RedisRouter(redis2, prefix, 1000);
    t.after(async () => {
      // Isolated random prefix; never flush the shared database.
      const keys = await redis1.keys(prefix + '*');
      if (keys.length) await redis1.del(...keys);
      await one.close();
      await two.close();
      // Router shutdown must leave the injected command connections available to other users.
      await Promise.all([redis1.ping(), redis2.ping()]);
      redis1.disconnect();
      redis2.disconnect();
    });
    await Promise.all([one.ready(), two.ready()]);
    const old: Session = {
      ownerId: 'owner-1',
      deviceId: 'device-1',
      authVersion: 1,
      deviceVersion: 1,
      sessionId: 'old',
      instanceId: 'one',
    };
    const fresh = { ...old, sessionId: 'fresh', instanceId: 'two' };
    await one.claim(old);
    assert.equal((await two.get(old.deviceId))!.instanceId, 'one');
    let wake: (value: string) => void = () => {};
    const woke = new Promise<string>((resolve) => {
      wake = resolve;
    });
    await two.subscribe(wake);
    await two.ready();
    await one.wake(old.deviceId);
    assert.equal(await woke, old.deviceId);
    await two.claim(fresh);
    await one.release(old);
    assert.equal(await one.renew(old), false);
    assert.equal((await one.get(fresh.deviceId))!.sessionId, 'fresh');
    assert.equal(
      await two.renew(fresh, {
        downloaderType: 'transmission',
        instanceId: 'target-1',
        configured: true,
        reachable: false,
      }
      ),
      true
    );
    assert.equal((await one.get(fresh.deviceId))!.status!.reachable, false);
    const observedAt = (await one.get(fresh.deviceId))!.statusObservedAt;
    assert.equal(typeof observedAt, 'number');
    await two.renew(fresh);
    assert.equal((await one.get(fresh.deviceId))!.statusObservedAt, observedAt);
    const limits = await Promise.all(Array.from({ length: 10 }, () => one.rateLimit('atomic', 3, 1000)));
    assert.equal(limits.filter(Boolean).length, 3);
    // Deterministically advance the Redis expiry rather than waiting for wall-clock time.
    await redis1.pexpire(`${prefix}device:${fresh.deviceId}`, 1);
    for (let i = 0; i < 100 && (await two.get(fresh.deviceId)); i++) await redis1.ping();
    assert.equal(await two.get(fresh.deviceId), null);
  });
