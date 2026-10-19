import type { migratedLocale } from './movie-locale-migration.js';

export interface LegacyMovie {
  _id: unknown;
  tmdbId?: unknown;
  title?: unknown;
  originalTitle?: unknown;
  overview?: unknown;
  tagline?: unknown;
  genres?: unknown;
  posterPath?: unknown;
  backdropPath?: unknown;
  genreIds?: unknown;
  releaseDate?: unknown;
  voteAverage?: unknown;
  voteCount?: unknown;
  imdbId?: unknown;
  runtimeMinutes?: unknown;
  summarySyncedAt?: unknown;
  detailSyncedAt?: unknown;
  activeCreditVersion?: unknown;
  updatedAt?: unknown;
}

export interface MovieLocaleMigrationReport {
  dryRun: boolean;
  migratedLocale: typeof migratedLocale;
  legacyMovieRows: number;
  localizationRowsToInsert: number;
  existingLocalizationRowsPreserved: number;
  consolidatedMovies: number;
  duplicateMovieRowsToRemove: number;
  assignedDefaultLocale: { people: number; movieCredits: number };
  stateAssociations: { total: number; resolvedTmdbIds: number; danglingTmdbIds: number };
}
