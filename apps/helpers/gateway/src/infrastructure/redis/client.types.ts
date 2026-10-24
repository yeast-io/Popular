import type { Logger } from 'pino';
import type { RedisCoordinator } from './coordinator.js';
import type { RedisGatewayBus } from './gateway-bus.service.js';

export interface RedisClientOptions {
  url: string;
  instanceId: string;
  token: string;
  logger: Logger;
  prefix?: string;
}

export interface RedisClient {
  coordinator: RedisCoordinator;
  bus: RedisGatewayBus;
  close(): Promise<void>;
}
