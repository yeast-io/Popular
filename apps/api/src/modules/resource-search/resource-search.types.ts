import type { ResourceSearchSourceInfo, ResourceSiteSearch, ResourceSiteRelease } from '@movie-hub/contract';
export interface ResourceSearchSource {
  readonly id: string;
  readonly name: string;
  readonly details: boolean;
  status(ownerId: string): Promise<ResourceSearchSourceInfo['status']>;
  search(ownerId: string, input: ResourceSiteSearch, signal: AbortSignal): Promise<{ releases: ResourceSiteRelease[]; nextPage?: number }>;
  detail?(ownerId: string, id: string, signal: AbortSignal): Promise<ResourceSiteRelease>;
}
