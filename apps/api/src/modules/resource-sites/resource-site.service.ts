import type { TorrentInput } from '@movie-hub/contract';
import { validateTorrentFile } from './torrent-file.schema.js';
import type { AgentResourceService } from '../agent-resources/agent-resource.service.js';
import { siteAccountIdentityPending } from './site-account.errors.js';
import type { IntegrationPreferencesService } from '../integrations/integration-preferences.service.js';
import { maskIntegrationSecret } from '@movie-hub/contract';
import { replacementSecret } from '../integrations/integration-secret.domain.js';
import { randomUUID } from 'node:crypto';
import type { ResourceSiteConfiguration, ResourceSiteSearch } from '@movie-hub/contract';
import type {
  ResourceSiteAdapter,
  ResourceSiteCredentialStore,
  ResourceSiteCredential,
  ResourceSiteDiagnostics,
  ResourceSiteSession,
} from './resource-site.types.js';
import type { SecretCrypto } from '../integrations/secret-crypto.js';
import type { ResourceSiteHttpClientPort } from './resource-site.types.js';
import { AiTrace, aiStep, currentAiTrace, withAiTrace } from '../../infrastructure/logging/ai-trace.js';
import { ResourceSiteError } from './resource-site.errors.js';

export class ResourceSiteService {
  preferences?: IntegrationPreferencesService;
  agentResources?: AgentResourceService;

  constructor(
    readonly registry: ReadonlyMap<string, ResourceSiteAdapter>,
    private readonly credentials: ResourceSiteCredentialStore,
    private readonly secrets: SecretCrypto,
    private readonly http: ResourceSiteHttpClientPort,
    private readonly diagnostics: ResourceSiteDiagnostics
  ) {}

  async cacheVersion(ownerId: string, site: string): Promise<string | undefined> {
    if (await this.agentResources?.enabled(ownerId)) return this.agentResources!.cacheVersion(ownerId, site);
    return (await this.credentials.find(ownerId, site))?.version;
  }

  async status(ownerId: string, site: string) {
    if (await this.agentResources?.enabled(ownerId)) return this.agentResources!.status(ownerId, site);
    this.adapter(site);
    const row = await this.credentials.find(ownerId, site);
    return !row
      ? 'unconfigured'
      : this.credentialUpdateRequired(site, row) || !row.externalUserId
        ? 'configured_invalid'
        : row.status;
  }

  async configuration(ownerId: string, site: string): Promise<ResourceSiteConfiguration> {
    if (await this.agentResources?.enabled(ownerId)) return this.agentResources!.configuration(ownerId, site);
    const adapter = this.adapter(site);
    const row = await this.credentials.find(ownerId, site);
    const apiKey = adapter.credentialType === 'apiKey';
    const base = {
      site,
      baseUrl: adapter.baseUrl,
      requiresPasskey: adapter.requiresPasskey ?? false,
      requiresApiKey: apiKey,
    };
    if (!row) return { ...base, status: 'unconfigured' };
    const update = this.credentialUpdateRequired(site, row);
    const encrypted = apiKey ? row.encryptedApiKey : row.encryptedCookie;
    return {
      ...base,
      status: update || !row.externalUserId ? 'configured_invalid' : row.status,
      ...(encrypted
        ? {
            [apiKey ? 'apiKeyMasked' : 'cookieMasked']: maskIntegrationSecret(
              this.secrets.decrypt(encrypted, this.context(ownerId, site))
            ),
          }
        : {}),
      ...(update ? { credentialUpdateRequired: true } : {}),
      verifiedAt: row.verifiedAt.toISOString(),
    };
  }

  async configure(
    ownerId: string,
    site: string,
    cookie?: string,
    _legacyPasskey?: string,
    apiKey?: string
  ): Promise<ResourceSiteConfiguration> {
    if (await this.agentResources?.enabled(ownerId)) throw new ResourceSiteError('agentModeConflict');
    return this.trace(ownerId, site, 'configure', async () => {
      const adapter = this.adapter(site);
      const existing = await this.credentials.find(ownerId, site);
      const usesApiKey = adapter.credentialType === 'apiKey';
      if ((usesApiKey && cookie !== undefined) || (!usesApiKey && apiKey !== undefined))
        throw new ResourceSiteError('invalidCredential');
      const encrypted = usesApiKey ? existing?.encryptedApiKey : existing?.encryptedCookie;
      const previous = encrypted ? this.secrets.decrypt(encrypted, this.context(ownerId, site)) : undefined;
      const replacement = replacementSecret(usesApiKey ? apiKey : cookie, previous);
      const revalidating = !replacement;
      if (!replacement && existing && this.credentialUpdateRequired(site, existing))
        throw new ResourceSiteError('apiKeyRequired');
      const credential = replacement ?? previous;
      if (!credential) throw new ResourceSiteError('invalidCredential');
      this.protect(credential);
      const session = await this.session(adapter, credential);
      let externalUserId: string;
      try {
        externalUserId = await aiStep('resource-sites.verify', () => adapter.verify(session));
        currentAiTrace()?.sensitive(externalUserId);
      } catch (error) {
        if (
          revalidating
          && existing
          && error instanceof ResourceSiteError
          && ['authentication', 'blocked'].includes(error.reason)
        )
          await this.invalidate(ownerId, site, existing.version);
        throw error;
      }
      await aiStep('resource-sites.credentials.save', () => {
        return this.credentials.save({
          ownerId,
          site,
          externalUserId,
          ...(usesApiKey
            ? { encryptedApiKey: this.secrets.encrypt(credential, this.context(ownerId, site)) }
            : { encryptedCookie: this.secrets.encrypt(credential, this.context(ownerId, site)) }),
          version: randomUUID(),
          status: 'configured_valid',
          verifiedAt: new Date(),
        });
      });
      await this.preferences?.configured(ownerId, 'resource', site);
      return this.configuration(ownerId, site);
    });
  }

  async torrentUrl(ownerId: string, site: string, id: string): Promise<TorrentInput> {
    if (await this.agentResources?.enabled(ownerId)) throw new ResourceSiteError('agentModeConflict');
    return this.trace(ownerId, site, 'torrent-url', async () => {
      const adapter = this.adapter(site);
      if (adapter.torrentFile) {
        return this.run(ownerId, site, 'torrent-file', async (siteAdapter, session) => {
          const bytes = await aiStep('resource-sites.torrent.read', () => siteAdapter.torrentFile!(session, id));
          validateTorrentFile(bytes);
          const metainfo = Buffer.from(bytes).toString('base64');
          currentAiTrace()?.sensitive(metainfo);
          return { metainfo };
        });
      }
      const row = await aiStep('resource-sites.credentials.load', () => this.credentials.find(ownerId, site));
      if (!row) throw new ResourceSiteError('notConfigured');
      if (!row.externalUserId) throw siteAccountIdentityPending();
      if (row.status !== 'configured_valid') throw new ResourceSiteError('authentication');
      if (adapter.resolveTorrentUrl) {
        return this.run(ownerId, site, 'download-link', async (siteAdapter, session) => {
          const url = await siteAdapter.resolveTorrentUrl!(session, id, row.externalUserId!);
          currentAiTrace()?.sensitive(url);
          return url;
        });
      }
      throw new ResourceSiteError('invalidResponse');
    });
  }

  async delete(ownerId: string, site: string): Promise<void> {
    return this.trace(ownerId, site, 'delete', async () => {
      this.adapter(site);
      await this.preferences?.beforeDelete(ownerId, 'resource', site);
      await this.credentials.delete(ownerId, site);
      await this.preferences?.deleted(ownerId, 'resource', site);
    });
  }

  async search(ownerId: string, site: string, input: ResourceSiteSearch, signal?: AbortSignal) {
    if (await this.agentResources?.enabled(ownerId))
      return this.agentResources!.search(ownerId, site, input, signal ?? AbortSignal.timeout(25_000));
    return this.run(ownerId, site, 'search', (adapter, session) => {
      currentAiTrace()?.sensitive(input.query ?? '');
      return adapter.search(session, input, signal);
    });
  }

  async detail(ownerId: string, site: string, id: string, signal?: AbortSignal) {
    if (await this.agentResources?.enabled(ownerId))
      return this.agentResources!.detail(ownerId, site, id, signal ?? AbortSignal.timeout(25_000));
    return this.run(ownerId, site, 'detail', (adapter, session) => adapter.detail(session, id, signal));
  }

  private async run<T>(
    ownerId: string,
    site: string,
    operation: string,
    action: (adapter: ResourceSiteAdapter, session: ResourceSiteSession) => Promise<T>
  ): Promise<T> {
    return this.trace(ownerId, site, operation, async () => {
      const adapter = this.adapter(site);
      const row = await aiStep('resource-sites.credentials.load', () => this.credentials.find(ownerId, site));
      if (!row) throw new ResourceSiteError('notConfigured');
      if (!row.externalUserId) throw siteAccountIdentityPending();
      if (row.status !== 'configured_valid') throw new ResourceSiteError('authentication');
      if (this.credentialUpdateRequired(site, row)) throw new ResourceSiteError('apiKeyRequired');
      const encrypted = adapter.credentialType === 'apiKey' ? row.encryptedApiKey : row.encryptedCookie;
      if (!encrypted) throw new ResourceSiteError('invalidCredential');
      const credential = this.secrets.decrypt(encrypted, this.context(ownerId, site));
      this.protect(credential);
      try {
        return await action(adapter, await this.session(adapter, credential));
      } catch (error) {
        if (error instanceof ResourceSiteError && ['authentication', 'blocked'].includes(error.reason))
          await this.invalidate(ownerId, site, row.version);
        throw error;
      }
    });
  }

  private async invalidate(ownerId: string, site: string, version: string): Promise<void> {
    try {
      await this.credentials.invalidate(ownerId, site, version);
    } catch (error) {
      currentAiTrace()?.fail(error, { stage: 'resource-sites.credentials.invalidate' });
    }
  }

  private adapter(site: string): ResourceSiteAdapter {
    const adapter = this.registry.get(site);
    if (!adapter) throw new ResourceSiteError('invalidResponse');
    return adapter;
  }

  private credentialUpdateRequired(site: string, row: ResourceSiteCredential): boolean {
    return this.adapter(site).credentialType === 'apiKey' && !row.encryptedApiKey;
  }

  private async session(adapter: ResourceSiteAdapter, credential: string): Promise<ResourceSiteSession> {
    if (adapter.credentialType === 'apiKey') {
      if (!/^[a-f0-9]{32}$/i.test(credential)) throw new ResourceSiteError('invalidCredential');
      if (!this.http.apiSession) throw new ResourceSiteError('invalidResponse');
      return this.http.apiSession(adapter.baseUrl, credential);
    }
    return this.http.session(adapter.baseUrl, credential);
  }

  private context(ownerId: string, site: string): string {
    return `movie-hub:resource-site:${site}:owner:${ownerId}`;
  }

  private protect(cookie: string): void {
    currentAiTrace()?.sensitive(cookie);
    for (const pair of cookie.split(';')) currentAiTrace()?.sensitive(pair.slice(pair.indexOf('=') + 1).trim());
  }

  private async trace<T>(ownerId: string, site: string, operation: string, action: () => Promise<T>): Promise<T> {
    const inherited = currentAiTrace();
    const trace
      = inherited
        ?? new AiTrace(this.diagnostics.logger, { ownerId, site }, '', 'resource-sites', this.diagnostics.verbose);
    return withAiTrace(trace, async () => {
      try {
        return await aiStep(`resource-sites.${operation}`, action, { site });
      } catch (error) {
        if (!inherited) trace.fail(error, { site, outcome: 'failure' });
        throw error;
      }
    });
  }
}
