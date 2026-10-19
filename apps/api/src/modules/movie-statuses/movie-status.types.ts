import type { MovieReleaseListResponse } from '@movie-hub/contract';

export interface MovieResourceCheckDispatcher {
  schedule(ownerId: string, tmdbId: number, options?: { force?: boolean }): void;
  request?(ownerId: string, tmdbId: number, force?: boolean): Promise<boolean>;
  listReleases?(ownerId: string, tmdbId: number): Promise<MovieReleaseListResponse>;
}
