import { Redis } from 'ioredis';
import { RedisRouter } from './redis-router.store.js';
import { RedisGatewayBus } from './gateway-bus.service.js';
import type { GatewayRedisOptions } from './gateway-redis.types.js';

export function createGatewayRedis(options: GatewayRedisOptions) {
  const connection = new Redis(options.url, {
    maxRetriesPerRequest: 1,
    connectTimeout: 5000,
    commandTimeout: 5000,
    enableOfflineQueue: false,
  });
  connection.on('error', (err) => options.logger.error({ err, stage: 'redis.connection' }, 'gateway'));
  const prefix = options.prefix ?? 'popular:gateway:v1:';
  const router = new RedisRouter(connection, prefix, 45_000, options.logger);
  const bus = new RedisGatewayBus(connection, options.instanceId, options.token, options.logger, prefix + 'relay:');

  return {
    router,
    bus,
    async close() {
      try {
        // The bus needs the shared connection to remove its leases and inbox.
        await bus.close();
      } finally {
        try {
          await router.close();
        } finally {
          connection.disconnect();
        }
      }
    },
  };
}
