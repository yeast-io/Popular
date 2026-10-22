import { createHmac, randomBytes } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { SessionStore } from '../../modules/auth/auth.types.js';

export class RedisSessionStore implements SessionStore {
  constructor(private readonly redis: Redis, private readonly pepper: string, private readonly ttlSeconds: number) {}

  async create(ownerId: string): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    await this.redis.set(this.key(token), ownerId, 'EX', this.ttlSeconds);
    return token;
  }

  getOwnerId(token: string): Promise<string | null> {
    return this.redis.get(this.key(token));
  }

  async delete(token: string): Promise<void> {
    await this.redis.del(this.key(token));
  }

  private key(token: string): string {
    return `session:${createHmac('sha256', this.pepper).update(token).digest('hex')}`;
  }
}
