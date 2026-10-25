import type { useResourceQuery } from './resource-query.client';
import type { ResourceSiteSearchResult } from '@movie-hub/contract';

export interface ResourceQueryGroup {
  site: string;
  name: string;
  loading: boolean;
  error: string;
  retryPage: number;
  result?: ResourceSiteSearchResult;
  queriedAt?: string;
}

export type ResourceQuerySession = ReturnType<typeof useResourceQuery>;
