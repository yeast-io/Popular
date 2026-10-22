import { Redis } from 'ioredis';
import type { HealthDependency } from '../health/health-dependency.types.js';
import { timedHealthCheck } from '../health/health-check.service.js';

export class RedisConnector implements HealthDependency {
  readonly name = 'redis' as const;
  private client: Redis | undefined;

  constructor(private readonly url: string, private readonly keyPrefix: string) {}

  async connect(): Promise<Redis> {
    if (this.client?.status === 'ready') return this.client;
    const client = new Redis(this.url, {
      keyPrefix: this.keyPrefix,
      lazyConnect: true,
      maxRetriesPerRequest: 2,
      connectTimeout: 5_000,
      enableOfflineQueue: false,
    });
    client.on('error', () => undefined);
    await client.connect();
    this.client = client;
    return client;
  }

  getClient(): Redis {
    if (!this.client || this.client.status !== 'ready') throw new Error('Redis is not connected');
    return this.client;
  }

  check() {
    return timedHealthCheck(async () => {
      const response = await this.getClient().ping();
      if (response !== 'PONG') throw new Error('Unexpected Redis PING response');
    });
  }

  async close(): Promise<void> {
    if (this.client) this.client.disconnect(false);
    this.client = undefined;
  }
}
