import type { TvShowRecord } from './tv-show.types.js';
import type { TvSeasonRecord, TvEpisodeRecord } from './tv-season.types.js';
import type { TvShowSummary, TvSeasonSummary, TvEpisode } from '@movie-hub/contract';

export function definedFields<T extends object>(record: T): {
  [K in keyof T]: Exclude<T[K], undefined>;
} {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)) as {
    [K in keyof T]: Exclude<T[K], undefined>;
  };
}
export const tvImageUrl = (path?: string): string | undefined => path ? `https://image.tmdb.org/t/p/w500${path}` : undefined;
export function tvShowSummary(record: TvShowRecord): TvShowSummary {
  return definedFields({ mediaType: 'tv' as const, tmdbId: record.tmdbId, name: record.name,
    originalName: record.originalName, overview: record.overview, firstAirDate: record.firstAirDate,
    voteAverage: record.voteAverage, posterUrl: tvImageUrl(record.posterPath), backdropUrl: tvImageUrl(record.backdropPath) });
}
export function tvSeasonSummary(record: TvSeasonRecord): TvSeasonSummary {
  const { episodes: _episodes, syncedAt: _syncedAt, posterPath, ...rest } = record;
  return definedFields({ ...rest, posterUrl: tvImageUrl(posterPath) });
}
export function tvEpisode(record: TvEpisodeRecord): TvEpisode {
  const { stillPath, ...rest } = record;
  return definedFields({ ...rest, stillUrl: tvImageUrl(stillPath) });
}
export const tvDate = (value?: Date | null): string | undefined => value?.toISOString().slice(0, 10);
