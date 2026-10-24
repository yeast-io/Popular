import type { Locale, TvEpisode, TvSeasonSummary } from '@movie-hub/contract';
import type { ExternalRequestContext } from '../external-usage/external-usage.types.js';

export interface TvEpisodeRecord extends Omit<TvEpisode, 'stillUrl'> {
  stillPath?: string;
}
export interface TvSeasonRecord extends Omit<TvSeasonSummary, 'posterUrl'> {
  posterPath?: string;
  episodes?: TvEpisodeRecord[];
  syncedAt?: Date;
}
export interface TvSeasonStore {
  readDetail(tmdbId: number, seasonNumber: number, locale: Locale): Promise<TvSeasonRecord | null>;
  readSummaries(tmdbId: number, locale: Locale): Promise<TvSeasonRecord[]>;
  writeSummaries(tmdbId: number, seasons: TvSeasonRecord[], locale: Locale, now: Date): Promise<void>;
  writeDetail(season: TvSeasonRecord, locale: Locale, now: Date): Promise<void>;
}
export interface TvSeasonProvider {
  fetchSeason(tmdbId: number, seasonNumber: number, locale: Locale, context: ExternalRequestContext): Promise<TvSeasonRecord>;
}
