import type { MovieSiteReleaseList } from '@movie-hub/contract';
import type { MovieResourceCheckExecution } from './movie-resource-check.types.js';

export interface MovieResourceBatchChecker {
  checkNowDetailed(
    ownerId: string,
    tmdbId: number,
    force?: boolean,
    sites?: string[],
  ): Promise<MovieResourceCheckExecution>;
  selectedSites?(ownerId: string): Promise<string[]>;
}
export interface MovieSiteReleaseCache {
  expiresAt: number;
  value: MovieSiteReleaseList;
}
