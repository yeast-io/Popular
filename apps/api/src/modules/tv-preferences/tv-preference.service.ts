import type { Locale, TrackedMoviePreference, TvShowSummary } from '@movie-hub/contract';
import type { TvShowCatalogStore } from '../tv-shows/tv-show.types.js';
import type { TvPreferenceStore } from './tv-preference.types.js';
import { aiStep } from '../../infrastructure/logging/ai-trace.js';
import { AppError } from '../../infrastructure/http/app-error.js';
import { tvShowMessages } from '../tv-shows/tv-show.presentation.js';

export class TvPreferenceService {
  constructor(
    private readonly store: TvPreferenceStore,
    private readonly catalog: Pick<TvShowCatalogStore, 'readSummaries'>
  ) {}

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
