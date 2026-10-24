export interface TvWatchlistStore {
  contains(ownerId: string, tmdbId: number): Promise<boolean>;
  add(ownerId: string, tmdbId: number): Promise<void>;
  remove(ownerId: string, tmdbId: number): Promise<void>;
  list(ownerId: string, page: number, pageSize: number): Promise<{ ids: number[]; total: number }>;
}
