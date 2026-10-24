import type { TrackedMoviePreference } from '@movie-hub/contract';

export interface TvPreferenceStore {
  read(ownerId: string, ids: number[]): Promise<{ tmdbId: number; preference: TrackedMoviePreference }[]>;
  set(ownerId: string, tmdbId: number, preference: TrackedMoviePreference): Promise<void>;
  clear(ownerId: string, tmdbId: number): Promise<void>;
}
