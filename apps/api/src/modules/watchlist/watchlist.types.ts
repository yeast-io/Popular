import type { MovieStatusStore } from '../movies/movie.types.js';

export interface TvWatchlistStore {
  contains(ownerId: string, tmdbId: number): Promise<boolean>;
  add(ownerId: string, tmdbId: number): Promise<void>;
  remove(ownerId: string, tmdbId: number): Promise<void>;
  setResourceNotification(ownerId: string, tmdbId: number, enabled: boolean): Promise<boolean>;
  list(ownerId: string, page: number, pageSize: number): Promise<{ ids: number[]; total: number; notificationEnabledIds: number[] }>;
}

export interface WatchlistMovieStore extends Pick<MovieStatusStore, 'list'> {
  setResourceNotification(ownerId: string, tmdbId: number, enabled: boolean): Promise<boolean>;
}
