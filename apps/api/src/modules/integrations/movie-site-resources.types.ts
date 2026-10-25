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
