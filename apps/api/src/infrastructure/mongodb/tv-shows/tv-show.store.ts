import { tvFieldUpdate } from './tv-storage.domain.js';
import type { Locale } from '@movie-hub/contract';
import type { Models } from '../models.types.js';
import type { TvShowCatalogStore, TvShowRecord } from '../../../modules/tv-shows/tv-show.types.js';
import type { TvSeasonStore } from '../../../modules/tv-shows/tv-season.types.js';
import { definedFields, tvDate } from '../../../modules/tv-shows/tv-show.domain.js';

export class MongoTvShowStore implements TvShowCatalogStore {
  constructor(
    private readonly models: Pick<Models, 'tvShows' | 'tvShowLocalizations'>,
    private readonly seasons: TvSeasonStore
  ) {}

  async upsertSummaries(shows: TvShowRecord[], locale: Locale, now: Date): Promise<void> {
    for (const show of shows) {
      await this.models.tvShows.updateOne({ tmdbId: show.tmdbId }, { $set: definedFields({
        tmdbId: show.tmdbId, originalName: show.originalName, originalLanguage: show.originalLanguage,
        firstAirDate: show.firstAirDate ? new Date(show.firstAirDate) : undefined,
        genreIds: show.genreIds, voteAverage: show.voteAverage, voteCount: show.voteCount, summarySyncedAt: now,
      }) }, { upsert: true }).exec();
      await this.models.tvShowLocalizations.updateOne({ tvShowTmdbId: show.tmdbId, locale }, { $set: definedFields({
        name: show.name, overview: show.overview, posterPath: show.posterPath, backdropPath: show.backdropPath, summarySyncedAt: now,
      }) }, { upsert: true }).exec();
    }
  }

  async writeDetail(show: TvShowRecord, locale: Locale, now: Date): Promise<void> {
    // Invalidate before replacing season summaries; publish completeness only after all writes.
    await this.models.tvShowLocalizations.updateOne({ tvShowTmdbId: show.tmdbId, locale }, { $unset: { detailSyncedAt: 1 } }).exec();
    await this.upsertSummaries([show], locale, now);
    await this.seasons.writeSummaries(show.tmdbId, show.seasons ?? [], locale, now);
    await this.models.tvShows.updateOne({ tmdbId: show.tmdbId }, tvFieldUpdate({
      lastAirDate: show.lastAirDate ? new Date(show.lastAirDate) : undefined, status: show.status,
      inProduction: show.inProduction, numberOfSeasons: show.numberOfSeasons, numberOfEpisodes: show.numberOfEpisodes, detailSyncedAt: now,
    })).exec();
    await this.models.tvShowLocalizations.updateOne({ tvShowTmdbId: show.tmdbId, locale }, {
      ...tvFieldUpdate({ tagline: show.tagline, taglineSyncedAt: now, trailer: show.trailer ? { ...show.trailer, ...(show.trailer.publishedAt ? { publishedAt: new Date(show.trailer.publishedAt) } : {}) } : undefined, trailerSyncedAt: now, genres: show.genres ?? [], name: show.name, overview: show.overview, posterPath: show.posterPath, backdropPath: show.backdropPath, detailSyncedAt: now }),
    }).exec();
  }

  async readSummaries(ids: number[], locale: Locale): Promise<TvShowRecord[]> {
    const [shows, translations] = await Promise.all([
      this.models.tvShows.find({ tmdbId: { $in: ids } }).lean().exec(),
      this.models.tvShowLocalizations.find({ tvShowTmdbId: { $in: ids }, locale }).lean().exec(),
    ]);
    const byId = new Map(shows.map((show) => [show.tmdbId, show]));
    const translated = new Map(translations.map((value) => [value.tvShowTmdbId, value]));
    return ids.flatMap((id): TvShowRecord[] => {
      const show = byId.get(id);
      const local = translated.get(id);
      if (!show || !local)
        return [];
      return [definedFields({ mediaType: 'tv' as const, tmdbId: id, name: local.name,
        originalName: show.originalName ?? undefined, originalLanguage: show.originalLanguage ?? undefined,
        tagline: local.tagline ?? undefined, taglineSyncedAt: local.taglineSyncedAt ?? undefined,
        trailerSyncedAt: local.trailerSyncedAt ?? undefined,
        trailer: local.trailer ? definedFields({ tmdbVideoId: local.trailer.tmdbVideoId, provider: 'youtube' as const, providerVideoId: local.trailer.providerVideoId, name: local.trailer.name, official: local.trailer.official, language: local.trailer.language ?? undefined, region: local.trailer.region ?? undefined, publishedAt: local.trailer.publishedAt?.toISOString() }) : undefined,
        overview: local.overview ?? undefined, posterPath: local.posterPath ?? undefined, backdropPath: local.backdropPath ?? undefined,
        firstAirDate: tvDate(show.firstAirDate), lastAirDate: tvDate(show.lastAirDate), genreIds: show.genreIds ?? [],
        status: show.status ?? undefined, inProduction: show.inProduction ?? undefined,
        numberOfSeasons: show.numberOfSeasons ?? undefined, numberOfEpisodes: show.numberOfEpisodes ?? undefined,
        voteAverage: show.voteAverage ?? undefined, voteCount: show.voteCount ?? undefined,
        genres: local.genres?.map((g) => ({ tmdbId: g.tmdbId, name: g.name })), syncedAt: local.detailSyncedAt ?? undefined,
      })];
    });
  }

  async readDetail(tmdbId: number, locale: Locale): Promise<TvShowRecord | null> {
    const [show] = await this.readSummaries([tmdbId], locale);
    if (!show?.syncedAt)
      return null;
    const seasons = await this.seasons.readSummaries(tmdbId, locale);
    const marker = await this.models.tvShowLocalizations.findOne({ tvShowTmdbId: tmdbId, locale }).lean().exec();
    if (marker?.detailSyncedAt?.getTime() !== show.syncedAt.getTime())
      return null;
    return { ...show, seasons };
  }
}
