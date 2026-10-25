import type { Ref } from 'vue';
import type { IntegrationPreferences } from '@movie-hub/contract';
import type { useResourceDownloads } from './resource-download.client';

export interface ResourceDownloadContext {
  tmdbId(): number | undefined;
  authenticated(): boolean;
  generation(): number;
  preferences: Ref<IntegrationPreferences | null>;
  open: Ref<boolean>;
  panel: Ref<HTMLElement | null>;
  activeRelease: Ref<string>;
  query?: () => string;
  page?: (site: string, releaseId: string) => number;
}
export type ResourceDownloads = ReturnType<typeof useResourceDownloads>;
