import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { test } from 'node:test';
import { gatewayLogger } from '../../gateway-logging.service.js';
import { createGatewayRedis } from './gateway-redis.service.js';

for (const failCleanup of [false, true]) {
  test(`REAL Redis: factory closes owned connections when bus cleanup ${failCleanup ? 'fails' : 'succeeds'}`, {
    skip: !process.env.GATEWAY_TEST_REDIS_URL,
    timeout: 15_000,
  }, async (t) => {
    const runtime = createGatewayRedis({
      url: process.env.GATEWAY_TEST_REDIS_URL!,
      instanceId: 'factory-test',
      token: 'independent-test-service-credential-123456',
      logger: gatewayLogger('silent'),
      prefix: `gateway-factory-test:${randomUUID()}:`,
    });
    t.after(async () => {
      await runtime.close().catch(() => {});
    });
    await runtime.router.ready();
    await runtime.bus.start(async () => null);
    assert.deepEqual(await runtime.bus.instances(), ['factory-test']);
    const ended = once(runtime.router.redis, 'end', { signal: AbortSignal.timeout(5000) });
    if (failCleanup) {
      const error = new Error('bus lease cleanup failed');
      runtime.bus.redis.del = async () => {
        throw error;
      };
      await assert.rejects(runtime.close(), (err) => err === error);
    } else {
      await runtime.close();
    }
    await ended;
    // No reconnecting command client or Router Pub/Sub connections may survive shutdown.
    assert.equal(runtime.router.redis.status, 'end');
    await assert.rejects(runtime.router.wake('device-1'));
    await assert.rejects(runtime.router.subscribe(() => {}));
  });
}
