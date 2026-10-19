import { RedisLockTrace } from './lock-trace.js';
import type { AiLogger } from '../logging/ai-trace.types.js';
import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { SyncLock } from '../../modules/movies/movie.types.js';

const RELEASE_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
end
return 0
`;

export class RedisSyncLock implements SyncLock {
  private readonly trace: RedisLockTrace;
  constructor(
    private readonly redis: Redis,
    traceEnabled = false,
    logger?: AiLogger
  ) {
    this.trace = new RedisLockTrace(traceEnabled, logger, (key) => this.redis.ttl(key));
  }

  async acquire(key: string, ttlSeconds: number): Promise<string | null> {
    const owner = randomUUID();
    const result = await this.trace.run(
      'acquire',
      [key],
      () => {
        return this.redis.set(key, owner, 'EX', ttlSeconds, 'NX');
      },
      { lockType: 'trending_sync', leaseSeconds: ttlSeconds },
    );
    return result === 'OK' ? owner : null;
  }

  async release(key: string, owner: string): Promise<void> {
    await this.trace.run(
      'release',
      [key],
      () => {
        return this.redis.eval(RELEASE_SCRIPT, 1, key, owner);
      },
      { lockType: 'trending_sync' },
    );
  }
}
