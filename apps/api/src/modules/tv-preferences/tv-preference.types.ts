import type { TrackedMoviePreference } from '@movie-hub/contract';

export interface TvPreferenceStore {
  list(ownerId: string, preference: TrackedMoviePreference, page: number, pageSize: number): Promise<{ ids: number[]; total: number }>;
  read(ownerId: string, ids: number[]): Promise<{ tmdbId: number; preference: TrackedMoviePreference }[]>;
  set(ownerId: string, tmdbId: number, preference: TrackedMoviePreference): Promise<void>;
  clear(ownerId: string, tmdbId: number): Promise<void>;
}
