import { AppError } from '../../infrastructure/http/app-error.js';
import { RESOURCE_REFRESH_INTERVAL_MS } from '@movie-hub/contract';
import { resourceSearchMessages } from '../resource-search/resource-search.messages.js';
import { createHash, randomUUID } from 'node:crypto';
import { aiStep, currentAiTrace } from '../../infrastructure/logging/ai-trace.js';
import type {
  ReleaseCacheIdentity,
  ResourceRefreshStore,
  MovieReleaseCacheQuery,
  MovieReleaseCacheStore,
} from './movie-release-cache.types.js';
import { MovieReleaseCacheError } from './movie-release-cache.errors.js';

export class MovieReleaseCacheService {
  private readonly pending = new Map<string, Promise<unknown>>();
  private readonly refreshing = new Map<string, Promise<unknown>>();

  constructor(
    private readonly store: MovieReleaseCacheStore,
    private readonly ttlMs: number,
    private readonly refreshStore?: ResourceRefreshStore
  ) {}

  async getOrFetch<T extends { cached: boolean; cacheExpiresAt?: string }>(query: MovieReleaseCacheQuery<T>): Promise<T> {
    const scopeKey = this.scopeKey(query.identity);
    const refreshKey = `${scopeKey}:refresh:${query.identity.page}`;
    const fields = { provider: query.identity.site, tmdbId: query.identity.tmdbId, page: query.identity.page };
    if (query.force) {
      if (this.refreshStore) {
        let remainingMs: number;
        try {
          remainingMs = await aiStep('resource-refresh.claim', () => this.refreshStore!.claim(query.identity.ownerId, query.identity.site, RESOURCE_REFRESH_INTERVAL_MS), fields);
        } catch (error) {
          throw new MovieReleaseCacheError('read', error);
        }
        if (remainingMs > 0) {
          const retryAfterSeconds = Math.ceil(remainingMs / 1000);
          currentAiTrace()?.event('resource-refresh.limited', { ...fields, retryAfterSeconds, outcome: 'rate_limited' });
          throw new AppError(429, 'RESOURCE_REFRESH_RATE_LIMITED',
            resourceSearchMessages[query.identity.locale === 'zh-CN' ? 'zh' : 'en'].refreshRateLimited, { retryAfterSeconds });
        }
      }
      const refreshing = this.refreshing.get(refreshKey);
      if (refreshing) {
        currentAiTrace()?.event('movie-resources.releases.cache', { ...fields, outcome: 'shared', cache: 'in_flight', forced: true });
        return refreshing as Promise<T>;
      }
      const task = (async () => {
        const previousRevision = await this.readRevision(scopeKey, fields);
        const previousKey = this.dataKey(scopeKey, previousRevision, query.identity.page);
        const prior = this.pending.get(previousKey);
        if (prior) await prior.catch(() => undefined);
        const value = await query.fetch();
        const revision = randomUUID();
        const result = await this.writeFetched(this.dataKey(scopeKey, revision, query.identity.page), query, value);
        try {
          await aiStep('movie-resources.cache.activate', () => {
            return this.store.activateRevision(scopeKey, revision, this.ttlMs * 2);
          }, fields);
        } catch (error) {
          throw new MovieReleaseCacheError('write', error);
        }
        return result;
      })().finally(() => this.refreshing.delete(refreshKey));
      this.refreshing.set(refreshKey, task);
      currentAiTrace()?.event('movie-resources.releases.cache', {
        ...fields, outcome: 'miss', cache: 'redis', reason: 'refresh', ttlMs: this.ttlMs,
      });
      return task;
    }

    const revision = await this.readRevision(scopeKey, fields);
    const key = this.dataKey(scopeKey, revision, query.identity.page);
    let cached;
    try {
      cached = await aiStep('movie-resources.cache.read', () => this.store.read(key), fields);
    } catch (error) {
      throw new MovieReleaseCacheError('read', error);
    }
    if (cached && query.validate(cached.value)) {
      currentAiTrace()?.event('movie-resources.releases.cache', {
        ...fields, outcome: 'hit', cache: 'redis', expiresInMs: Math.max(0, Date.parse(cached.expiresAt) - Date.now()),
      });
      return { ...cached.value, cached: true, cacheExpiresAt: cached.expiresAt };
    }
    const pending = this.pending.get(key) ?? this.refreshing.get(refreshKey);
    if (pending) {
      currentAiTrace()?.event('movie-resources.releases.cache', { ...fields, outcome: 'shared', cache: 'in_flight', forced: false });
      return pending as Promise<T>;
    }
    currentAiTrace()?.event('movie-resources.releases.cache', {
      ...fields, outcome: 'miss', cache: 'redis', reason: cached ? 'invalid' : 'absent_or_expired', ttlMs: this.ttlMs,
    });
    const task = this.fetchAndWrite(key, query).finally(() => this.pending.delete(key));
    this.pending.set(key, task);
    return task;
  }

  async readCached<T extends { cached: boolean; cacheExpiresAt?: string }>(
    query: Pick<MovieReleaseCacheQuery<T>, 'identity' | 'validate'>
  ): Promise<T | null> {
    const fields = { provider: query.identity.site, tmdbId: query.identity.tmdbId, page: query.identity.page };
    const scopeKey = this.scopeKey(query.identity);
    const revision = await this.readRevision(scopeKey, fields);
    try {
      const entry = await aiStep('movie-resources.cache.read', () => this.store.read(this.dataKey(scopeKey, revision, query.identity.page)), fields);
      const hit = entry && query.validate(entry.value);
      currentAiTrace()?.event('movie-resources.releases.cache', { ...fields, outcome: hit ? 'hit' : 'miss', cache: 'redis', cacheOnly: true });
      if (!entry || !query.validate(entry.value)) return null;
      return { ...entry.value, cached: true, cacheExpiresAt: entry.expiresAt };
    } catch (error) {
      throw new MovieReleaseCacheError('read', error);
    }
  }

  async waitForIdle(): Promise<void> {
    await Promise.allSettled([...this.pending.values(), ...this.refreshing.values()]);
  }

  private async fetchAndWrite<T extends { cached: boolean; cacheExpiresAt?: string }>(
    key: string,
    query: MovieReleaseCacheQuery<T>
  ): Promise<T> {
    const value = await query.fetch();
    return this.writeFetched(key, query, value);
  }

  private async writeFetched<T extends { cached: boolean; cacheExpiresAt?: string }>(
    key: string,
    query: MovieReleaseCacheQuery<T>,
    value: T
  ): Promise<T> {
    let cacheExpiresAt: string;
    try {
      cacheExpiresAt = await aiStep('movie-resources.cache.write', () => {
        return this.store.write(key, { ...value, cached: false }, this.ttlMs);
      }, { provider: query.identity.site, tmdbId: query.identity.tmdbId, page: query.identity.page });
    } catch (error) {
      throw new MovieReleaseCacheError('write', error);
    }
    return { ...value, cached: false, cacheExpiresAt };
  }

  private async readRevision(scopeKey: string, fields: Record<string, unknown>): Promise<string | null> {
    try {
      return await aiStep('movie-resources.cache.revision', () => this.store.readRevision(scopeKey), fields);
    } catch (error) {
      throw new MovieReleaseCacheError('read', error);
    }
  }

  private scopeKey(identity: ReleaseCacheIdentity): string {
    if ('query' in identity) {
      const hash = createHash('sha256').update(JSON.stringify([
        identity.ownerId, identity.site, identity.mediaType, identity.query, identity.locale, identity.credentialVersion,
      ])).digest('hex');
      return `resource-query:scope:v1:${hash}`;
    }
    const hash = createHash('sha256').update(JSON.stringify([
      identity.ownerId, identity.site, identity.tmdbId,
      identity.imdbId ?? null, identity.locale, identity.credentialVersion,
    ])).digest('hex');
    return `movie-releases:scope:v1:${hash}`;
  }

  private dataKey(scopeKey: string, revision: string | null, page: number): string {
    return `${scopeKey}:data:${revision ?? 'initial'}:${page}`;
  }
}
