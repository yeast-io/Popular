import type { Locale } from '@movie-hub/contract';
import { RpcError } from '@movie-hub/contract/socket-rpc';
import { AppError } from '../../infrastructure/http/app-error.js';
import { aiStep, currentAiTrace } from '../../infrastructure/logging/ai-trace.js';
import { userExternalRequestContext } from '../external-usage/external-usage.domain.js';
import { integrationSecretContext } from '../integrations/integration.service.js';
import type { IntegrationConfigRecord } from '../integrations/integration.types.js';
import { siteAccountIdentityPending } from '../resource-sites/site-account.errors.js';
import { ResourceSiteError } from '../resource-sites/resource-site.errors.js';
import { downloadSourceMessages } from './download-source.messages.js';
import type {
  DownloadSourceDependencies,
  DownloadSourceRequest,
  LocalDownloadSourceRequest,
  PreparedDownloadSource,
} from './download-source.types.js';

export class DownloadSourceService {
  constructor(private readonly dependencies: DownloadSourceDependencies) {}

  async prepareLocal(input: LocalDownloadSourceRequest): Promise<PreparedDownloadSource> {
    const config = await this.configuration(input, false, input.locale);
    if (config && !config.externalUserId) throw siteAccountIdentityPending();
    const release = await aiStep('download.resources.validate', async () => {
      if (input.resource) return input.resource;
      return this.validateRelease(input, false);
    }, { sourceProvider: input.source, releaseId: input.releaseId });
    // Resolve only after the caller wins the task claim. Keep the verified configuration pinned.
    return { release, torrentUrl: () => this.torrentUrl(input, config, false) };
  }

  async resolveRemote(input: DownloadSourceRequest): Promise<string> {
    // Movie downloads are revalidated when delivered; TV resources were validated before enqueueing.
    if (input.tmdbId !== undefined) {
      await aiStep('download.resources.validate', () => this.validateRelease(input, true),
        { sourceProvider: input.source, releaseId: input.releaseId });
    }
    const config = await this.configuration(input, true);
    return this.torrentUrl(input, config, true);
  }

  private async validateRelease(input: DownloadSourceRequest, remote: boolean) {
    if (input.tmdbId === undefined) throw new AppError(404, 'NOT_FOUND', '');
    // Preserve the remote movie/catalog check and the local M-Team validation contract.
    if (remote || input.source !== 'mteam') {
      if (!this.dependencies.siteDownloads) throw new ResourceSiteError('notConfigured');
      return this.dependencies.siteDownloads.resources.releaseForDownload(
        input.ownerId, input.tmdbId, input.source, input.releaseId
      );
    }
    const list = await this.dependencies.resources.listReleases(input.ownerId, input.tmdbId);
    const release = list.releases.find((item) => item.id === input.releaseId);
    if (!release) throw new AppError(404, 'NOT_FOUND', '');
    return release;
  }

  private async configuration(input: DownloadSourceRequest, remote: boolean, locale: Locale = 'en-US') {
    if (input.source !== 'mteam') {
      if (!this.dependencies.siteDownloads) throw new ResourceSiteError('notConfigured');
      return null;
    }
    return aiStep('download.source.configuration', async () => {
      const config = await this.dependencies.configs.find(input.ownerId, 'mteam');
      if (!config) {
        if (remote) throw new RpcError('RESOURCE_SITE_NOT_CONFIGURED', 'not_applied');
        throw new AppError(409, 'MTEAM_NOT_CONFIGURED', downloadSourceMessages[locale].mteamNotConfigured);
      }
      return config;
    }, { sourceProvider: input.source });
  }

  private async torrentUrl(input: DownloadSourceRequest, config: IntegrationConfigRecord | null, remote: boolean) {
    return aiStep('download.source.torrent-url', async () => {
      const url = input.source !== 'mteam'
        ? await this.dependencies.siteDownloads!.sites.torrentUrl(input.ownerId, input.source, input.releaseId)
        : await this.dependencies.mteam.torrentUrl(
            config!.baseUrl,
            this.dependencies.secrets.decrypt(config!.encryptedApiKey, integrationSecretContext(input.ownerId, 'mteam')),
            input.releaseId,
            remote ? undefined : userExternalRequestContext(input.ownerId, 'api_request')
          );
      currentAiTrace()?.sensitive(url);
      return url;
    }, { sourceProvider: input.source, releaseId: input.releaseId });
  }
}
