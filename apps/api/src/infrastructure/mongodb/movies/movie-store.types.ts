import type { MovieDetailRecord } from '../../../modules/movies/movie.types.js';

export interface ResolvedLocalization {
  locale: string;
  title: string;
  overview?: string;
  tagline?: string;
  posterPath?: string;
  backdropPath?: string;
  genres?: Array<{ tmdbId: number; name: string }>;
  trailer?: MovieDetailRecord['trailer'];
  summarySyncedAt: Date;
  detailSyncedAt?: Date;
  trailerSyncedAt?: Date;
}
