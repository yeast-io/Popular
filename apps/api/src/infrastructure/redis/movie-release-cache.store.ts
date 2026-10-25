import { createHash } from 'node:crypto';
import type { Redis } from 'ioredis';
import type {
  MovieReleaseCacheEntry,
  MovieReleaseCacheStore,
  ResourceRefreshStore,
} from '../../modules/integrations/movie-release-cache.types.js';

export class RedisMovieReleaseCacheStore implements MovieReleaseCacheStore {
  constructor(private readonly redis: Redis) {}

  async read(key: string): Promise<MovieReleaseCacheEntry | null> {
    const raw = await this.redis.get(key);
    if (!raw) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    if (!this.isEntry(parsed) || Date.parse(parsed.expiresAt) <= Date.now()) {
      return null;
    }
    return parsed;
  }

  async write(key: string, value: unknown, ttlMs: number): Promise<string> {
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    await this.redis.set(key, JSON.stringify({ value, expiresAt }), 'PX', ttlMs);
    return expiresAt;
  }

  readRevision(scopeKey: string): Promise<string | null> {
    return this.redis.get(scopeKey);
  }

  async activateRevision(scopeKey: string, revision: string, ttlMs: number): Promise<void> {
    await this.redis.set(scopeKey, revision, 'PX', ttlMs);
  }

  private isEntry(value: unknown): value is MovieReleaseCacheEntry {
    return value !== null && typeof value === 'object' && 'value' in value
      && 'expiresAt' in value && typeof value.expiresAt === 'string'
      && Number.isFinite(Date.parse(value.expiresAt));
  }
}

const claimScript = `
if redis.call('SET', KEYS[1], '1', 'PX', ARGV[1], 'NX') then
  return 0
end
return math.max(1, redis.call('PTTL', KEYS[1]))
`;

export class RedisResourceRefreshStore implements ResourceRefreshStore {
  constructor(private readonly redis: Redis) {}

  async claim(ownerId: string, site: string, intervalMs: number): Promise<number> {
    const hash = createHash('sha256').update(JSON.stringify([ownerId, site])).digest('hex');
    return Number(await this.redis.eval(claimScript, 1, `resource-refresh:v1:${hash}`, intervalMs));
  }
}
