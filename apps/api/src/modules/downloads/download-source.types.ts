import type { Locale, ResourceSiteRelease } from '@movie-hub/contract';
import type { MovieResourceCheckService } from '../integrations/movie-resource-check.service.js';
import type { MovieSiteResourcesService } from '../integrations/movie-site-resources.service.js';
import type { IntegrationConfigStore } from '../integrations/integration.types.js';
import type { MTeamTorrentUrlProvider } from '../integrations/movie-resource-check.types.js';
import type { SecretCrypto } from '../integrations/secret-crypto.js';
import type { ResourceSiteService } from '../resource-sites/resource-site.service.js';

export interface DownloadSourceRequest {
  ownerId: string;
  tmdbId?: number | undefined;
  source: string;
  releaseId: string;
}

export interface PreparedDownloadSource {
  release: ResourceSiteRelease;
  torrentUrl(): Promise<string>;
}

export interface DownloadSourceDependencies {
  configs: Pick<IntegrationConfigStore, 'find'>;
  secrets: Pick<SecretCrypto, 'decrypt'>;
  mteam: MTeamTorrentUrlProvider;
  resources: Pick<MovieResourceCheckService, 'listReleases'>;
  siteDownloads?: {
    resources: Pick<MovieSiteResourcesService, 'releaseForDownload'>;
    sites: Pick<ResourceSiteService, 'torrentUrl'>;
  };
}

export interface LocalDownloadSourceRequest extends DownloadSourceRequest {
  resource?: ResourceSiteRelease | undefined;
  locale: Locale;
}
