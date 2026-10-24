import { randomUUID } from 'node:crypto';
import type { Locale, TvTrendingResponse } from '@movie-hub/contract';
import { AppError } from '../../infrastructure/http/app-error.js';
import { aiStep, currentAiTrace } from '../../infrastructure/logging/ai-trace.js';
import { userExternalRequestContext } from '../external-usage/external-usage.domain.js';
import type { TvShowProvider, TvTrendingSnapshot, TvTrendingStore } from './tv-show.types.js';
import type { TvSyncLock, TvTrendingOptions } from './tv-trending-sync.types.js';
import { tvShowPolicy } from './tv-show.policy.js';
import { tvShowMessages } from './tv-show.presentation.js';
import { tvShowSummary } from './tv-show.domain.js';

export class TvTrendingSyncService {
  constructor(
    private readonly provider: TvShowProvider,
    private readonly store: TvTrendingStore,
    private readonly lock: TvSyncLock,
    private readonly options: TvTrendingOptions
  ) {}

  async trending(page: number, locale: Locale, ownerId: string | null, generation?: string): Promise<TvTrendingResponse> {
    if (page > 1 && !generation)
      throw new AppError(409, 'CONFLICT', tvShowMessages(locale).snapshot);
    let record = await aiStep('tv.trending.cache.read', () => this.store.readPage(page, locale, generation), { page, locale });
    let stale = false;
    if (!record || (!generation && record.freshUntil.getTime() <= Date.now())) {
      const key = `lock:sync:trending:tv:week:${locale}`;
      const owner = await this.lock.acquire(key, tvShowPolicy.lockTtlSeconds);
      if (!owner) {
        if (!record)
          throw new AppError(409, 'CONFLICT', tvShowMessages(locale).busy);
        stale = true;
      } else {
        const cached = record;
        try {
          // Recheck after acquiring the distributed lock.
          record = await this.store.readPage(page, locale, generation);
          if (!record || (!generation && record.freshUntil.getTime() <= Date.now())) {
            const first = generation ? await this.store.readPage(1, locale, generation) : null;
            if (generation && !first)
              throw new AppError(409, 'CONFLICT', tvShowMessages(locale).snapshot);
            if (page > 1 && !(await this.store.readPage(page - 1, locale, generation)))
              throw new AppError(409, 'CONFLICT', tvShowMessages(locale).snapshot);
            const fetched = await aiStep('tv.trending.provider', () => this.provider.fetchTrending(page, locale, userExternalRequestContext(ownerId, 'api_request')), { page, locale });
            const now = new Date();
            const seen = new Set(generation ? await this.store.readIds(locale, generation) : []);
            record = { ...fetched, items: fetched.items.filter((item) => !seen.has(item.tmdbId)),
              generation: generation ?? randomUUID(), fetchedAt: first?.fetchedAt ?? now,
              freshUntil: first?.freshUntil ?? new Date(now.getTime() + this.options.freshnessMs) };
            await aiStep('tv.trending.publish', () => this.store.writePage(record!, locale, !generation), { page, locale, generation: record.generation });
          }
        } catch (error) {
          currentAiTrace()?.fail(error, { page, locale, outcome: 'failure', fallback: Boolean(cached) });
          currentAiTrace()?.clearFailure();
          if (!cached) {
            if (error instanceof AppError)
              throw error;
            throw new AppError(503, 'SERVICE_UNAVAILABLE', tvShowMessages(locale).unavailable, undefined, { cause: error });
          }
          record = cached;
          stale = true;
        } finally {
          await this.lock.release(key, owner);
        }
      }
    }
    return this.response(record!, locale, stale || record!.freshUntil.getTime() <= Date.now());
  }

  private response(record: TvTrendingSnapshot, locale: Locale, stale: boolean): TvTrendingResponse {
    return { items: record.items.map(tvShowSummary), page: record.page,
      hasMore: record.page < Math.min(record.totalPages, tvShowPolicy.maxPage),
      generation: record.generation, fetchedAt: record.fetchedAt.toISOString(), stale, locale };
  }
}
