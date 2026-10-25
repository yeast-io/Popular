import type { MovieSiteReleaseList } from '@movie-hub/contract';

export interface MovieSiteReleaseGroup {
  site: string;
  name: string;
  supportsDownload: boolean;
  loading: boolean;
  error: string;
  refreshAvailableAt?: number;
  result?: MovieSiteReleaseList;
}
