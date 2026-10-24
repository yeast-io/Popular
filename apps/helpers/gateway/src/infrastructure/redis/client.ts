import { Redis } from 'ioredis';
import { RedisCoordinator } from './coordinator.js';
import { RedisGatewayBus } from './gateway-bus.service.js';
import type { RedisClient, RedisClientOptions } from './client.types.js';

export function createRedisClient(options: RedisClientOptions): RedisClient {
  const connection = new Redis(options.url, {
    maxRetriesPerRequest: 1,
    connectTimeout: 5000,
    commandTimeout: 5000,
    enableOfflineQueue: false,
  });
  connection.on('error', (err) => options.logger.error({ err, stage: 'redis.connection' }, 'gateway'));
  const prefix = options.prefix ?? 'popular:gateway:v1:';
  const coordinator = new RedisCoordinator(connection, prefix, 45_000, options.logger);
  const bus = new RedisGatewayBus(connection, options.instanceId, options.token, options.logger, prefix + 'relay:');

  return {
    coordinator,
    bus,
    async close() {
      try {
        // The bus needs the shared connection to remove its leases and inbox.
        await bus.close();
      } finally {
        try {
          await coordinator.close();
        } finally {
          connection.disconnect();
        }
      }
    },
  };
}
