import type { AiLogger } from '../../infrastructure/logging/ai-trace.types.js';
import type { MediaTrendingLock } from '../media-trending/media-trending.types.js';
import type { Locale, MovieTrailer, TvShowSummary } from '@movie-hub/contract';
import type { TvSeasonRecord } from './tv-season.types.js';
import type { ExternalRequestContext } from '../external-usage/external-usage.types.js';

export interface TvShowRecord extends Omit<TvShowSummary, 'posterUrl' | 'backdropUrl'> {
  tagline?: string;
  taglineSyncedAt?: Date;
  trailer?: MovieTrailer;
  trailerSyncedAt?: Date;
  originalLanguage?: string;
  posterPath?: string;
  backdropPath?: string;
  genreIds: number[];
  voteCount?: number;
  lastAirDate?: string;
  status?: string;
  inProduction?: boolean;
  numberOfSeasons?: number;
  numberOfEpisodes?: number;
  genres?: {
    tmdbId: number;
    name: string;
  }[];
  seasons?: TvSeasonRecord[];
  syncedAt?: Date;
}
export interface TvShowCatalogStore {
  readDetail(tmdbId: number, locale: Locale): Promise<TvShowRecord | null>;
  writeDetail(show: TvShowRecord, locale: Locale, now: Date): Promise<void>;
  upsertSummaries(shows: TvShowRecord[], locale: Locale, now: Date): Promise<void>;
  readSummaries(ids: number[], locale: Locale): Promise<TvShowRecord[]>;
}
export interface TvShowProvider {
  search(query: string, page: number, locale: Locale, context: ExternalRequestContext): Promise<TvTrendingPage>;
  fetchTrending(page: number, locale: Locale, context: ExternalRequestContext): Promise<TvTrendingPage>;
  fetchDetail(tmdbId: number, locale: Locale, context: ExternalRequestContext): Promise<TvShowRecord>;
}
export interface TvTrendingPage {
  items: TvShowRecord[];
  page: number;
  totalPages: number;
  totalResults: number;
}
export interface TvDiagnostics {
  logger: AiLogger;
  verbose: boolean;
}
export type TvSyncLock = MediaTrendingLock;
