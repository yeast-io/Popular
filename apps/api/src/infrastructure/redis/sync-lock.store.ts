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
  constructor(private readonly redis: Redis) {}

  async acquire(key: string, ttlSeconds: number): Promise<string | null> {
    const owner = randomUUID();
    const result = await this.redis.set(key, owner, 'EX', ttlSeconds, 'NX');
    return result === 'OK' ? owner : null;
  }

  async release(key: string, owner: string): Promise<void> {
    await this.redis.eval(RELEASE_SCRIPT, 1, key, owner);
  }
}
