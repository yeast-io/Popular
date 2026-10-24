import type { Locale, TrackedMoviePreference, TvShowSummary, WatchlistResponse } from '@movie-hub/contract';
import type { TvShowCatalogStore } from '../tv-shows/tv-show.types.js';
import type { TvPreferenceStore } from './tv-preference.types.js';
import { aiStep } from '../../infrastructure/logging/ai-trace.js';
import { AppError } from '../../infrastructure/http/app-error.js';
import { tvShowMessages } from '../tv-shows/tv-show.presentation.js';
import { definedFields, tvShowSummary } from '../tv-shows/tv-show.domain.js';
import { unavailableTvPreferenceTitle } from './tv-preference.presentation.js';

export class TvPreferenceService {
  constructor(
    private readonly store: TvPreferenceStore,
    private readonly catalog: Pick<TvShowCatalogStore, 'readSummaries'>
  ) {}

  async list(ownerId: string, preference: TrackedMoviePreference, page: number, pageSize: number, locale: Locale): Promise<WatchlistResponse> {
    const result = await aiStep('tv.preference.list', () => this.store.list(ownerId, preference, page, pageSize), { page, pageSize });
    const shows = await aiStep('tv.preference.catalog', () => this.catalog.readSummaries(result.ids, locale), { count: result.ids.length, locale });
    const available = new Set(shows.map((show) => show.tmdbId));
    const missing = result.ids.filter((id) => !available.has(id));
    const fallback = missing.length ? await aiStep('tv.preference.catalog.fallback', () => this.catalog.readSummaries(missing, locale === 'zh-CN' ? 'en-US' : 'zh-CN'), { count: missing.length }) : [];
    const byId = new Map([...fallback, ...shows].map((show) => [show.tmdbId, tvShowSummary(show)]));
    return {
      items: result.ids.map((tmdbId) => {
        const show = byId.get(tmdbId);
        return definedFields({ mediaType: 'tv' as const, tmdbId, title: show?.name || show?.originalName || unavailableTvPreferenceTitle(locale, tmdbId), overview: show?.overview, posterUrl: show?.posterUrl, releaseDate: show?.firstAirDate, voteAverage: show?.voteAverage });
      }),
      pagination: { page, pageSize, total: result.total, hasMore: page * pageSize < result.total },
      locale,
    };
  }

  async apply(ownerId: string | null, items: TvShowSummary[]): Promise<TvShowSummary[]> {
    const saved = ownerId && items.length ? await aiStep('tv.preference.read', () => this.store.read(ownerId, items.map((item) => item.tmdbId)), { count: items.length }) : [];
    const byId = new Map(saved.map((item) => [item.tmdbId, item.preference]));
    return items.map((item) => ({ ...item, userPreference: byId.get(item.tmdbId) ?? 'neutral' }));
  }

  async set(ownerId: string, tmdbId: number, preference: TrackedMoviePreference, locale: Locale) {
    const shows = await aiStep('tv.preference.validate', () => this.catalog.readSummaries([tmdbId], locale), { tmdbId, locale });
    if (!shows.length) throw new AppError(404, 'NOT_FOUND', tvShowMessages(locale).notFound);
    await aiStep('tv.preference.save', () => this.store.set(ownerId, tmdbId, preference), { tmdbId });
    return { tmdbId, preference };
  }

  async clear(ownerId: string, tmdbId: number) {
    await aiStep('tv.preference.clear', () => this.store.clear(ownerId, tmdbId), { tmdbId });
    return { tmdbId, preference: 'neutral' as const };
  }
}
