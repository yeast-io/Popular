import type { Locale, TvShowDetail, TvSearchResponse } from '@movie-hub/contract';
import { AppError } from '../../infrastructure/http/app-error.js';
import { TmdbHttpError } from '../../infrastructure/tmdb/tmdb-http.client.js';
import { aiStep, currentAiTrace } from '../../infrastructure/logging/ai-trace.js';
import { userExternalRequestContext } from '../external-usage/external-usage.domain.js';
import type { TvShowCatalogStore, TvShowProvider } from './tv-show.types.js';
import type { TvSyncLock } from './tv-show.types.js';
import { tvShowPolicy } from './tv-show.policy.js';
import { tvShowMessages } from './tv-show.presentation.js';
import { definedFields, tvShowSummary, tvSeasonSummary } from './tv-show.domain.js';

export class TvShowService {
  constructor(
    private readonly catalog: TvShowCatalogStore,
    private readonly provider: TvShowProvider,
    private readonly lock: TvSyncLock
  ) {}

  async search(query: string, page: number, locale: Locale, ownerId: string | null): Promise<TvSearchResponse> {
    const term = query.trim();
    if (!term || term.length > 100 || !Number.isInteger(page) || page < 1 || page > tvShowPolicy.maxPage) {
      throw new AppError(400, 'BAD_REQUEST', tvShowMessages(locale).invalidSearch);
    }
    currentAiTrace()?.sensitive(term);
    // Never attach the search term to trace fields or persist it in the catalog.
    try {
      const result = await aiStep('tv.search.provider', () => this.provider.search(term, page, locale,
        userExternalRequestContext(ownerId, 'api_request')), { page, locale });
      await aiStep('tv.search.persist', () => this.catalog.upsertSummaries(result.items, locale, new Date()), { page, locale });
      return { items: result.items.map(tvShowSummary), page: result.page,
        hasMore: result.page < Math.min(result.totalPages, tvShowPolicy.maxPage), stale: false, locale };
    } catch (error) {
      throw new AppError(503, 'SERVICE_UNAVAILABLE', tvShowMessages(locale).unavailable, undefined, { cause: error });
    }
  }

  async detail(tmdbId: number, locale: Locale, ownerId: string | null): Promise<TvShowDetail> {
    const cached = await aiStep('tv.detail.cache.read', () => this.catalog.readDetail(tmdbId, locale), { tmdbId, locale });
    let show = cached;
    let stale = false;
    if (!cached?.syncedAt || !cached.trailerSyncedAt || !cached.taglineSyncedAt || Date.now() - cached.syncedAt.getTime() >= tvShowPolicy.detailTtlMs) {
      const key = `lock:tv:detail:${tmdbId}:${locale}`;
      const owner = await this.lock.acquire(key, tvShowPolicy.lockTtlSeconds);
      if (!owner) {
        if (!cached)
          throw new AppError(409, 'CONFLICT', tvShowMessages(locale).busy);
        stale = true;
      } else {
        try {
          show = await aiStep('tv.detail.provider', () => this.provider.fetchDetail(tmdbId, locale, userExternalRequestContext(ownerId, 'api_request')), { tmdbId, locale });
          const now = new Date();
          await aiStep('tv.detail.persist', () => this.catalog.writeDetail(show!, locale, now), { tmdbId, locale });
          show = { ...show, syncedAt: now, trailerSyncedAt: now, taglineSyncedAt: now };
        } catch (error) {
          currentAiTrace()?.fail(error, { outcome: 'failure', fallback: Boolean(cached), tmdbId, locale });
          currentAiTrace()?.clearFailure();
          if (!cached)
            throw new AppError(error instanceof TmdbHttpError && error.status === 404 ? 404 : 503, error instanceof TmdbHttpError && error.status === 404 ? 'NOT_FOUND' : 'SERVICE_UNAVAILABLE', error instanceof TmdbHttpError && error.status === 404 ? tvShowMessages(locale).notFound : tvShowMessages(locale).unavailable, undefined, { cause: error });
          show = cached;
          stale = true;
        } finally {
          await this.lock.release(key, owner);
        }
      }
    }
    if (!show?.syncedAt)
      throw new AppError(503, 'SERVICE_UNAVAILABLE', tvShowMessages(locale).unavailable);
    return definedFields({ ...tvShowSummary(show), tagline: show.tagline, trailer: show.trailer, lastAirDate: show.lastAirDate, status: show.status,
      inProduction: show.inProduction, numberOfSeasons: show.numberOfSeasons, numberOfEpisodes: show.numberOfEpisodes,
      voteCount: show.voteCount, genres: show.genres ?? [], seasons: (show.seasons ?? []).map(tvSeasonSummary),
      detailSyncedAt: show.syncedAt.toISOString(), stale, locale });
  }
}
