import type { ResourceSiteSearch } from '@movie-hub/contract';
import type { ResourceSearchSource } from './resource-search.types.js';
import type { ResourceSiteService } from '../resource-sites/resource-site.service.js';

export class ResourceSiteSearchSource implements ResourceSearchSource {
  readonly details = true;

  constructor(
    readonly id: string,
    readonly name: string,
    private readonly sites: Pick<ResourceSiteService, 'status' | 'search' | 'detail'>
  ) {}

  async status(ownerId: string) {
    return await this.sites.status(ownerId, this.id);
  }

  async search(ownerId: string, input: ResourceSiteSearch, signal: AbortSignal) {
    const result = await this.sites.search(ownerId, this.id, input, signal);
    return {
      releases: result.releases,
      ...(result.nextPage && result.nextPage <= 100 ? { nextPage: result.nextPage } : {}),
    };
  }

  detail(ownerId: string, id: string, signal: AbortSignal) {
    return this.sites.detail(ownerId, this.id, id, signal);
  }
}
