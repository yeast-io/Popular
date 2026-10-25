import type { Locale, TvSeasonDetail } from '@movie-hub/contract';
import { AppError } from '../../infrastructure/http/app-error.js';
import { TmdbHttpError } from '../../infrastructure/tmdb/tmdb-http.client.js';
import { aiStep, currentAiTrace } from '../../infrastructure/logging/ai-trace.js';
import { userExternalRequestContext } from '../external-usage/external-usage.domain.js';
import type { TvSeasonProvider, TvSeasonStore } from './tv-season.types.js';
import type { TvSyncLock } from './tv-show.types.js';
import { tvShowPolicy } from './tv-show.policy.js';
import { tvShowMessages } from './tv-show.presentation.js';
import { tvSeasonSummary, tvEpisode } from './tv-show.domain.js';

export class TvSeasonService {
  constructor(
    private readonly store: TvSeasonStore,
    private readonly provider: TvSeasonProvider,
    private readonly lock: TvSyncLock
  ) {}

  async detail(tmdbId: number, seasonNumber: number, locale: Locale, ownerId: string | null): Promise<TvSeasonDetail> {
    const fields = { tmdbId, seasonNumber, locale };
    const cached = await aiStep('tv.season.cache.read', () => this.store.readDetail(tmdbId, seasonNumber, locale), fields);
    let season = cached;
    let stale = false;
    if (!cached?.syncedAt || Date.now() - cached.syncedAt.getTime() >= tvShowPolicy.detailTtlMs) {
      const key = `lock:tv:season:${tmdbId}:${seasonNumber}`;
      const owner = await this.lock.acquire(key, tvShowPolicy.lockTtlSeconds);
      if (!owner) {
        if (!cached)
          throw new AppError(409, 'CONFLICT', tvShowMessages(locale).busy);
        stale = true;
      } else {
        try {
          season = await aiStep('tv.season.provider', () => this.provider.fetchSeason(tmdbId, seasonNumber, locale, userExternalRequestContext(ownerId, 'api_request')), fields);
          const now = new Date();
          await aiStep('tv.season.persist', () => this.store.writeDetail(season!, locale, now), fields);
          season = { ...season, syncedAt: now };
        } catch (error) {
          currentAiTrace()?.fail(error, { ...fields, outcome: 'failure', fallback: Boolean(cached) });
          currentAiTrace()?.clearFailure();
          if (!cached)
            throw new AppError(error instanceof TmdbHttpError && error.status === 404 ? 404 : 503, error instanceof TmdbHttpError && error.status === 404 ? 'NOT_FOUND' : 'SERVICE_UNAVAILABLE', error instanceof TmdbHttpError && error.status === 404 ? tvShowMessages(locale).notFound : tvShowMessages(locale).unavailable, undefined, { cause: error });
          season = cached;
          stale = true;
        } finally {
          await this.lock.release(key, owner);
        }
      }
    }
    if (!season?.syncedAt)
      throw new AppError(503, 'SERVICE_UNAVAILABLE', tvShowMessages(locale).unavailable);
    return { ...tvSeasonSummary(season), episodes: (season.episodes ?? []).map(tvEpisode),
      detailSyncedAt: season.syncedAt.toISOString(), stale, locale };
  }
}
