import { tvFieldUpdate } from './tv-storage.domain.js';
import type { Locale } from '@movie-hub/contract';
import type { Models } from '../models.types.js';
import type { TvSeasonStore, TvSeasonRecord, TvEpisodeRecord } from '../../../modules/tv-shows/tv-season.types.js';
import { definedFields, tvDate } from '../../../modules/tv-shows/tv-show.domain.js';

export class MongoTvSeasonStore implements TvSeasonStore {
  constructor(
    private readonly models: Pick<Models, 'tvSeasons' | 'tvSeasonLocalizations' | 'tvEpisodes' | 'tvEpisodeLocalizations'>
  ) {}

  async writeSummaries(tmdbId: number, seasons: TvSeasonRecord[], locale: Locale, now: Date): Promise<void> {
    for (const season of seasons)
      await this.writeSummary(season, locale, now);
    // Remove only this locale's obsolete season links. Other locales and user-independent episode caches remain intact.
    await this.models.tvSeasonLocalizations.deleteMany({ tvShowTmdbId: tmdbId, locale,
      seasonNumber: { $nin: seasons.map((s) => s.seasonNumber) } }).exec();
  }

  private async writeSummary(season: TvSeasonRecord, locale: Locale, now: Date): Promise<void> {
    const identity = { tvShowTmdbId: season.tvShowTmdbId, seasonNumber: season.seasonNumber };
    await this.models.tvSeasons.updateOne(identity, { $set: definedFields({ tmdbId: season.tmdbId,
      airDate: season.airDate ? new Date(season.airDate) : undefined, episodeCount: season.episodeCount,
      voteAverage: season.voteAverage, summarySyncedAt: now }) }, { upsert: true }).exec();
    await this.models.tvSeasonLocalizations.updateOne({ ...identity, locale }, { $set: definedFields({
      name: season.name, overview: season.overview, posterPath: season.posterPath, summarySyncedAt: now,
    }) }, { upsert: true }).exec();
  }

  async readSummaries(tmdbId: number, locale: Locale): Promise<TvSeasonRecord[]> {
    const [seasons, translations] = await Promise.all([
      this.models.tvSeasons.find({ tvShowTmdbId: tmdbId }).sort({ seasonNumber: 1 }).lean().exec(),
      this.models.tvSeasonLocalizations.find({ tvShowTmdbId: tmdbId, locale }).lean().exec(),
    ]);
    const byNumber = new Map(translations.map((local) => [local.seasonNumber, local]));
    return seasons.flatMap((season): TvSeasonRecord[] => {
      const local = byNumber.get(season.seasonNumber);
      if (!local)
        return [];
      return [definedFields({ tmdbId: season.tmdbId, tvShowTmdbId: tmdbId, seasonNumber: season.seasonNumber,
        name: local.name, overview: local.overview ?? undefined, posterPath: local.posterPath ?? undefined,
        airDate: tvDate(season.airDate), episodeCount: season.episodeCount ?? undefined,
        voteAverage: season.voteAverage ?? undefined, syncedAt: local.episodeListSyncedAt ?? undefined,
      })];
    });
  }

  async writeDetail(season: TvSeasonRecord, locale: Locale, now: Date): Promise<void> {
    const identity = { tvShowTmdbId: season.tvShowTmdbId, seasonNumber: season.seasonNumber };
    await this.models.tvSeasonLocalizations.updateOne({ ...identity, locale }, { $unset: { episodeListSyncedAt: 1 } }).exec();
    await this.writeSummary(season, locale, now);
    const episodes = season.episodes ?? [];
    // Batch large seasons to keep persistence within the distributed lease.
    for (let offset = 0; offset < episodes.length; offset += 100) {
      const batch = episodes.slice(offset, offset + 100);
      await this.models.tvEpisodes.bulkWrite(batch.map((episode) => ({ updateOne: {
        filter: { ...identity, episodeNumber: episode.episodeNumber },
        update: tvFieldUpdate({ tmdbId: episode.tmdbId, ...identity, episodeNumber: episode.episodeNumber,
          airDate: episode.airDate ? new Date(episode.airDate) : undefined, runtimeMinutes: episode.runtimeMinutes,
          episodeType: episode.episodeType, voteAverage: episode.voteAverage, voteCount: episode.voteCount, detailSyncedAt: now }),
        upsert: true,
      } })));
      await this.models.tvEpisodeLocalizations.bulkWrite(batch.map((episode) => ({ updateOne: {
        filter: { ...identity, episodeNumber: episode.episodeNumber, locale },
        update: tvFieldUpdate({ name: episode.name, overview: episode.overview, stillPath: episode.stillPath, detailSyncedAt: now }),
        upsert: true,
      } })));
    }
    await this.models.tvEpisodeLocalizations.deleteMany({ ...identity, locale,
      episodeNumber: { $nin: (season.episodes ?? []).map((e) => e.episodeNumber) } }).exec();
    await this.models.tvSeasons.updateOne(identity, tvFieldUpdate({ detailSyncedAt: now,
      airDate: season.airDate ? new Date(season.airDate) : undefined, voteAverage: season.voteAverage,
    })).exec();
    await this.models.tvSeasonLocalizations.updateOne({ ...identity, locale }, {
      ...tvFieldUpdate({ name: season.name, overview: season.overview, posterPath: season.posterPath, detailSyncedAt: now, episodeListSyncedAt: now }),
    }).exec();
  }

  async readDetail(tmdbId: number, seasonNumber: number, locale: Locale): Promise<TvSeasonRecord | null> {
    const season = (await this.readSummaries(tmdbId, locale)).find((s) => s.seasonNumber === seasonNumber);
    if (!season?.syncedAt)
      return null;
    const identity = { tvShowTmdbId: tmdbId, seasonNumber };
    const [episodes, translations] = await Promise.all([
      this.models.tvEpisodes.find(identity).sort({ episodeNumber: 1 }).lean().exec(),
      this.models.tvEpisodeLocalizations.find({ ...identity, locale }).lean().exec(),
    ]);
    const byNumber = new Map(episodes.map((e) => [e.episodeNumber, e]));
    // A failed/overlapping write must never become a complete cached season.
    if (translations.some((e) => e.detailSyncedAt?.getTime() !== season.syncedAt!.getTime())
      || translations.length !== season.episodeCount)
      return null;
    const records: TvEpisodeRecord[] = [];
    for (const local of translations) {
      const episode = byNumber.get(local.episodeNumber);
      if (!episode)
        return null;
      records.push(definedFields({ ...identity, tmdbId: episode.tmdbId, episodeNumber: episode.episodeNumber,
        name: local.name, overview: local.overview ?? undefined, stillPath: local.stillPath ?? undefined,
        airDate: tvDate(episode.airDate), runtimeMinutes: episode.runtimeMinutes ?? undefined,
        voteAverage: episode.voteAverage ?? undefined, voteCount: episode.voteCount ?? undefined, episodeType: episode.episodeType ?? undefined,
      }));
    }
    const marker = await this.models.tvSeasonLocalizations.findOne({ ...identity, locale }).lean().exec();
    if (marker?.episodeListSyncedAt?.getTime() !== season.syncedAt.getTime())
      return null;
    return { ...season, episodes: records.sort((a, b) => a.episodeNumber - b.episodeNumber) };
  }
}
