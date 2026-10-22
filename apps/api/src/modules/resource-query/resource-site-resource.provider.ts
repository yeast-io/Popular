import type { Locale } from '@movie-hub/contract';
import type { ResourceProvider, ResourceSourceResult } from './resource-query.types.js';
import type { ResourceSiteService } from '../resource-sites/resource-site.service.js';
import type { MovieCatalogStore } from '../movies/movie.types.js';

export class ResourceSiteResourceProvider implements ResourceProvider {
  constructor(
    readonly id: string,
    readonly name: string,
    private readonly sites: ResourceSiteService,
    private readonly movies: Pick<MovieCatalogStore, 'readMovieIdentity'>,
    private readonly locale: Locale
  ) {}

  async query(ownerId: string, tmdbId: number, signal: AbortSignal): Promise<ResourceSourceResult> {
    signal.throwIfAborted();
    const identity = await this.movies.readMovieIdentity?.(tmdbId, this.locale);
    // Site keyword results can include unrelated films. Assistant lookups require an external identity.
    if (!identity?.imdbId) return { provider: this.id, status: 'unmatchable', releases: [] };
    const result = await this.sites.search(ownerId, this.id, { imdbId: identity.imdbId }, signal);
    signal.throwIfAborted();
    return {
      provider: this.id,
      status: result.releases.length ? 'available' : 'unavailable',
      releases: result.releases.map((release) => {
        return { ...release, provider: this.id };
      }),
      queriedAt: new Date().toISOString(),
      cached: false,
    };
  }
}
