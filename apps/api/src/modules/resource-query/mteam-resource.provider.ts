import type { MovieResourceCheckService } from '../integrations/movie-resource-check.service.js';
import type { ResourceProvider, ResourceSourceResult } from './resource-query.types.js';

/** Keeps the shared query contract independent of M-Team and its torrent-specific fields. */
export class MTeamResourceProvider implements ResourceProvider {
  readonly id = 'mteam';
  readonly name = 'M-Team';
  constructor(
    private readonly resources: Pick<MovieResourceCheckService, 'listReleases'>
  ) {}
  async query(ownerId: string, tmdbId: number, signal: AbortSignal, options?: { refresh: boolean }): Promise<ResourceSourceResult> {
    signal.throwIfAborted();
    const result = await this.resources.listReleases(ownerId, tmdbId, { force: options?.refresh ?? false });
    signal.throwIfAborted();
    return {
      provider: this.id,
      status: result.availability === 'unchecked' ? 'error' : result.availability,
      queriedAt: result.queriedAt,
      cached: result.cached,
      releases: result.releases.map(({ id, title, sizeBytes, resolution, seeders }) => {
        return ({
          provider: this.id, id, title,
          ...(sizeBytes !== undefined ? { sizeBytes } : {}),
          ...(resolution ? { resolution } : {}),
          seeders,
        });
      }),
    };
  }
}
