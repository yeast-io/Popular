import type { Logger } from 'pino';

export interface GatewayRedisOptions {
  url: string;
  instanceId: string;
  token: string;
  logger: Logger;
  prefix?: string;
}
