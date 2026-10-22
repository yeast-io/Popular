import { siteAccountIdentityPending } from '../resource-sites/site-account.errors.js';
import { MTEAM_SEARCH_MINIMUM_INTERVAL_MS } from './resource-search.policy.js';
import type { ResourceSiteSearch, ResourceSiteRelease } from '@movie-hub/contract';
import type { ResourceSearchSource } from './resource-search.types.js';
import type { IntegrationConfigStore } from '../integrations/integration.types.js';
import type { SecretCrypto } from '../integrations/secret-crypto.js';
import type { MTeamClient } from '../../infrastructure/mteam/client.js';
import { integrationSecretContext, IntegrationValidationError } from '../integrations/integration.service.js';
import { userExternalRequestContext } from '../external-usage/external-usage.domain.js';
import { ResourceSiteError } from '../resource-sites/resource-site.errors.js';
import { aiStep, currentAiTrace } from '../../infrastructure/logging/ai-trace.js';

export class MTeamSearchSource implements ResourceSearchSource {
  private readonly active = new Set<string>();
  private readonly cooldown = new Set<string>();
  readonly id = 'mteam';
  readonly name = 'M-Team';
  readonly details = false;

  constructor(
    private readonly configs: Pick<IntegrationConfigStore, 'find'>,
    private readonly secrets: SecretCrypto,
    private readonly client: Pick<MTeamClient, 'searchMoviePage'>,
    private readonly intervalMs = MTEAM_SEARCH_MINIMUM_INTERVAL_MS
  ) {}

  async status(ownerId: string) {
    const config = await this.configs.find(ownerId, 'mteam');
    return !config
      ? ('unconfigured' as const)
      : !config.externalUserId || config.lastFailureType
          ? ('configured_invalid' as const)
          : config.verifiedAt
            ? ('configured_valid' as const)
            : ('configured_unverified' as const);
  }

  async search(ownerId: string, input: ResourceSiteSearch, signal: AbortSignal) {
    signal.throwIfAborted();
    if (this.active.has(ownerId) || this.cooldown.has(ownerId)) throw new ResourceSiteError('rateLimited');
    this.active.add(ownerId);
    try {
      return await this.execute(ownerId, input, signal);
    } finally {
      this.active.delete(ownerId);
      if (this.intervalMs > 0) {
        this.cooldown.add(ownerId);
        setTimeout(() => this.cooldown.delete(ownerId), this.intervalMs).unref();
      }
    }
  }

  private async execute(ownerId: string, input: ResourceSiteSearch, signal: AbortSignal) {
    signal.throwIfAborted();
    const config = await this.configs.find(ownerId, 'mteam');
    if (!config) throw new ResourceSiteError('notConfigured');
    if (!config.externalUserId) throw siteAccountIdentityPending();
    const key = this.secrets.decrypt(config.encryptedApiKey, integrationSecretContext(ownerId, 'mteam'));
    currentAiTrace()?.sensitive(key);
    try {
      const result = await aiStep('resource-search.mteam.search', () => {
        return this.client.searchMoviePage(
          config.baseUrl,
          key,
          input.imdbId ? { imdbId: input.imdbId } : { title: input.query! },
          userExternalRequestContext(ownerId, 'api_request'),
          { page: input.page ?? 1, signal }
        );
      });
      signal.throwIfAborted();
      const releases: ResourceSiteRelease[] = result.releases
        .filter((r) => {
          return r.id && r.title && r.visible && !r.banned;
        })
        .map((r) => {
          return {
            id: r.id!,
            title: r.title!,
            seeders: r.seeders,
            ...(r.sizeBytes !== undefined ? { sizeBytes: r.sizeBytes } : {}),
            ...(r.imdbId ? { imdbId: r.imdbId } : {}),
            ...(r.resolution ? { resolution: r.resolution } : {}),
            ...(r.releaseGroup ? { releaseGroup: r.releaseGroup } : {}),
          };
        });
      return { releases, ...(result.nextPage ? { nextPage: result.nextPage } : {}) };
    } catch (error) {
      if (signal.aborted) throw error;
      if (error instanceof IntegrationValidationError) {
        const reasons = {
          authentication: 'authentication',
          permission: 'blocked',
          rate_limited: 'rateLimited',
          timeout: 'timeout',
          network: 'network',
          remote_error: 'invalidResponse',
          invalid_response: 'invalidResponse',
        } as const;
        throw new ResourceSiteError(reasons[error.failureType], { cause: error });
      }
      throw error;
    }
  }
}
