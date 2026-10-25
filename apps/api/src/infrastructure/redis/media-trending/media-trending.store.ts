import type { Locale } from '@movie-hub/contract';
import type { Redis } from 'ioredis';
import { mediaTrendingSnapshotSchema } from '../../../modules/media-trending/media-trending.schema.js';
import type { MediaTrendingSnapshot } from '../../../modules/media-trending/media-trending.schema.js';
import type { MediaTrendingKind, MediaTrendingLease, MediaTrendingStore } from '../../../modules/media-trending/media-trending.types.js';

const publishScript = `
if redis.call('GET', KEYS[2]) ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[3])
return 1
`;

export class RedisMediaTrendingStore implements MediaTrendingStore {
  constructor(private readonly redis: Pick<Redis, 'get' | 'eval'>) {}

  private key(media: MediaTrendingKind, locale: Locale): string {
    return `media-trending:v1:${media}:week:${locale}`;
  }

  async read(media: MediaTrendingKind, locale: Locale): Promise<MediaTrendingSnapshot | null> {
    const raw = await this.redis.get(this.key(media, locale));
    if (!raw) return null;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
    const parsed = mediaTrendingSnapshotSchema.safeParse(value);
    return parsed.success && parsed.data.expiresAt > Date.now() ? parsed.data : null;
  }

  async write(media: MediaTrendingKind, locale: Locale, snapshot: MediaTrendingSnapshot, lease: MediaTrendingLease): Promise<void> {
    const record = mediaTrendingSnapshotSchema.parse(snapshot);
    const ttlMs = record.expiresAt - Date.now();
    if (ttlMs <= 0) throw new Error('Trending snapshot expired before publication');
    const published = await this.redis.eval(publishScript, 2, this.key(media, locale), lease.key, lease.owner, JSON.stringify(record), ttlMs);
    if (published !== 1) throw new Error('Trending refresh lost its lock before publication');
  }
}
