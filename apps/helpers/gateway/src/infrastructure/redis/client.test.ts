import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { test } from 'node:test';
import { gatewayLogger } from '../../gateway-logging.service.js';
import { createRedisClient } from './client.js';

for (const failCleanup of [false, true]) {
  test(`REAL Redis: factory closes owned connections when bus cleanup ${failCleanup ? 'fails' : 'succeeds'}`, {
    skip: !process.env.GATEWAY_TEST_REDIS_URL,
    timeout: 15_000,
  }, async (t) => {
    const client = createRedisClient({
      url: process.env.GATEWAY_TEST_REDIS_URL!,
      instanceId: 'factory-test',
      token: 'independent-test-service-credential-123456',
      logger: gatewayLogger('silent'),
      prefix: `gateway-factory-test:${randomUUID()}:`,
    });
    t.after(async () => {
      await client.close().catch(() => {});
    });
    await client.coordinator.ready();
    await client.bus.start(async () => null);
    assert.deepEqual(await client.bus.instances(), ['factory-test']);
    const ended = once(client.coordinator.redis, 'end', { signal: AbortSignal.timeout(5000) });
    if (failCleanup) {
      const error = new Error('bus lease cleanup failed');
      client.bus.redis.del = async () => {
        throw error;
      };
      await assert.rejects(client.close(), (err) => err === error);
    } else {
      await client.close();
    }
    await ended;
    // No reconnecting command client or GatewayCoordinator Pub/Sub connections may survive shutdown.
    assert.equal(client.coordinator.redis.status, 'end');
    await assert.rejects(client.coordinator.wake('device-1'));
    await assert.rejects(client.coordinator.subscribe(() => {}));
  });
}
