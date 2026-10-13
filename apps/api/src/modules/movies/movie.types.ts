export interface MovieRecord {
  tmdbId: number;
  title: string;
  originalTitle?: string;
  overview?: string;
  releaseDate?: string;
  posterPath?: string;
  backdropPath?: string;
  genreIds: number[];
  voteAverage?: number;
  voteCount?: number;
  summarySyncedAt?: Date;
  localizationLocale?: Locale;
}

export interface GenreRecord { tmdbId: number; name: string }
export interface PersonRecord { tmdbId: number; name: string; originalName?: string; profilePath?: string }
export interface CreditRecord { person: PersonRecord; creditId: string; type: 'cast' | 'director'; character?: string; order?: number }

export interface MovieDetailRecord extends MovieRecord {
  imdbId?: string;
  tagline?: string;
  runtimeMinutes?: number;
  genres: GenreRecord[];
  cast: CreditRecord[];
  directors: CreditRecord[];
  detailSyncedAt?: Date;
}

export interface TrendingPageRecord {
  movies: MovieRecord[];
  page: number;
  totalPages: number;
  totalResults: number;
  fetchedAt: Date;
  expectedMovieCount?: number;
}

export interface TrendingSnapshotPageRecord extends TrendingPageRecord {
  generation: string;
}

export interface TrendingSnapshotRecord {
  generation: string;
  pages: TrendingPageRecord[];
  sourcePage: number;
  pageSize: number;
  fetchedAt: Date;
}

export interface TrendingStore {
  publishSnapshot(record: TrendingSnapshotRecord, locale: Locale): Promise<void>;
  appendSnapshotPage(record: TrendingPageRecord, locale: Locale, generation: string, sourcePage: number, pageSize: number): Promise<void>;
  readPage(page: number, locale: Locale, generation?: string): Promise<TrendingSnapshotPageRecord | null>;
  readSnapshot(locale: Locale, generation: string): Promise<TrendingSnapshotRecord | null>;
}

export interface MovieCatalogStore {
  upsertMovies(movies: MovieRecord[], syncedAt: Date, locale: Locale): Promise<void>;
  readMovies(tmdbIds: number[], locale: Locale): Promise<MovieRecord[]>;
  hasMovie(tmdbId: number): Promise<boolean>;
  writeMovieDetail(movie: MovieDetailRecord, syncedAt: Date, locale: Locale): Promise<void>;
  readMovieDetail(tmdbId: number, locale: Locale): Promise<MovieDetailRecord | null>;
  publishSearch(query: string, record: TrendingPageRecord, locale: Locale): Promise<void>;
  readSearch(query: string, page: number, locale: Locale): Promise<TrendingPageRecord | null>;
  readMovieIdentity?(tmdbId: number, locale: Locale): Promise<{ title: string; imdbId?: string } | null>;
}

export interface MovieStatusRecord {
  tmdbId: number;
  status: 'watched' | 'interested' | 'not_interested';
  updatedAt: Date;
}

export interface MovieStatusStore {
  set(ownerId: string, tmdbId: number, status: MovieStatusRecord['status']): Promise<MovieStatusRecord['status'] | null>;
  delete(ownerId: string, tmdbId: number): Promise<void>;
  readForMovies(ownerId: string, tmdbIds: number[]): Promise<MovieStatusRecord[]>;
  list(ownerId: string, status: MovieStatusRecord['status'] | undefined, page: number, pageSize: number): Promise<{ items: MovieStatusRecord[]; total: number }>;
}

export interface TrendingProvider {
  fetchPage(page: number, locale: Locale, context?: import('../external-usage/external-usage.types.js').ExternalRequestContext): Promise<Omit<TrendingPageRecord, 'fetchedAt'>>;
}

export interface MovieSearchProvider {
  search(query: string, page: number, locale: Locale, context?: import('../external-usage/external-usage.types.js').ExternalRequestContext): Promise<Omit<TrendingPageRecord, 'fetchedAt'>>;
  fetchDetails(tmdbId: number, locale: Locale, context?: import('../external-usage/external-usage.types.js').ExternalRequestContext): Promise<MovieDetailRecord>;
}

export interface SyncLock {
  acquire(key: string, ttlSeconds: number): Promise<string | null>;
  release(key: string, owner: string): Promise<void>;
}
import type { Locale } from '@movie-hub/contract';
