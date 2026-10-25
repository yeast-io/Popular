import type { useResourceQuery } from './resource-query.client';
import type { ResourceSiteSearchResult } from '@movie-hub/contract';

export interface ResourceQueryGroup {
  site: string;
  name: string;
  loading: boolean;
  error: string;
  refreshAvailableAt?: number;
  retryPage: number;
  result?: ResourceSiteSearchResult;
  queriedAt?: string;
  releasePages?: Record<string, number>;
}

export type ResourceQuerySession = ReturnType<typeof useResourceQuery>;
