import type { IntegrationPreferencesService } from '../integrations/integration-preferences.service.js';
import { maskIntegrationSecret } from '@movie-hub/contract';
import { replacementSecret } from '../integrations/integration-secret.domain.js';
import { randomUUID } from 'node:crypto';
import type { ResourceSiteConfiguration, ResourceSiteSearch } from '@movie-hub/contract';
import type {
  ResourceSiteAdapter,
  ResourceSiteCredentialStore,
  ResourceSiteDiagnostics,
  ResourceSiteSession,
} from './resource-site.types.js';
import type { SecretCrypto } from '../integrations/secret-crypto.js';
import type { ResourceSiteHttpClient } from '../../infrastructure/resource-sites/resource-site-http.client.js';
import { AiTrace, aiStep, currentAiTrace, withAiTrace } from '../../infrastructure/logging/ai-trace.js';
import { ResourceSiteError } from './resource-site.errors.js';

export class ResourceSiteService {
  preferences?: IntegrationPreferencesService;

  constructor(
    readonly registry: ReadonlyMap<string, ResourceSiteAdapter>,
    private readonly credentials: ResourceSiteCredentialStore,
    private readonly secrets: SecretCrypto,
    private readonly http: Pick<ResourceSiteHttpClient, 'session'>,
    private readonly diagnostics: ResourceSiteDiagnostics
  ) {}

  async cacheVersion(ownerId: string, site: string): Promise<string | undefined> {
    return (await this.credentials.find(ownerId, site))?.version;
  }

  async status(ownerId: string, site: string) {
    this.adapter(site);
    return (await this.credentials.find(ownerId, site))?.status ?? 'unconfigured';
  }

  async configuration(ownerId: string, site: string): Promise<ResourceSiteConfiguration> {
    this.adapter(site);
    const row = await this.credentials.find(ownerId, site);
    return row
      ? {
          site,
          status: row.status,
          cookieMasked: maskIntegrationSecret(this.secrets.decrypt(row.encryptedCookie, this.context(ownerId, site))),
          ...(row.encryptedPasskey
            ? {
                passkeyMasked: maskIntegrationSecret(
                  this.secrets.decrypt(row.encryptedPasskey, `${this.context(ownerId, site)}:passkey`)
                ),
              }
            : {}),
          verifiedAt: row.verifiedAt.toISOString(),
        }
      : { site, status: 'unconfigured' };
  }

  async configure(
    ownerId: string,
    site: string,
    cookie?: string,
    passkey?: string
  ): Promise<ResourceSiteConfiguration> {
    return this.trace(ownerId, site, 'configure', async () => {
      const adapter = this.adapter(site);
      const existing = await this.credentials.find(ownerId, site);
      cookie = replacementSecret(
        cookie,
        existing ? this.secrets.decrypt(existing.encryptedCookie, this.context(ownerId, site)) : undefined
      );
      passkey = replacementSecret(
        passkey,
        existing?.encryptedPasskey
          ? this.secrets.decrypt(existing.encryptedPasskey, `${this.context(ownerId, site)}:passkey`)
          : undefined
      );
      if (passkey && /\s/.test(passkey)) throw new ResourceSiteError('invalidCredential');
      const revalidating = !cookie;
      if (!cookie) {
        const row = existing;
        if (!row) throw new ResourceSiteError('invalidCredential');
        cookie = this.secrets.decrypt(row.encryptedCookie, this.context(ownerId, site));
      }
      this.protect(cookie);
      if (passkey) currentAiTrace()?.sensitive(passkey);
      const session = await this.http.session(adapter.baseUrl, cookie);
      try {
        await aiStep('resource-sites.verify', () => adapter.verify(session));
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
          ...(passkey
            ? { encryptedPasskey: this.secrets.encrypt(passkey, `${this.context(ownerId, site)}:passkey`) }
            : existing?.encryptedPasskey
              ? { encryptedPasskey: existing.encryptedPasskey }
              : {}),
          encryptedCookie: this.secrets.encrypt(cookie!, this.context(ownerId, site)),
          version: randomUUID(),
          status: 'configured_valid',
          verifiedAt: new Date(),
        }
        );
      });
      await this.preferences?.configured(ownerId, 'resource', site);
      return this.configuration(ownerId, site);
    });
  }

  async torrentUrl(ownerId: string, site: string, id: string): Promise<string> {
    return this.trace(ownerId, site, 'torrent-url', async () => {
      const adapter = this.adapter(site);
      const row = await aiStep('resource-sites.credentials.load', () => this.credentials.find(ownerId, site));
      if (!row) throw new ResourceSiteError('notConfigured');
      if (row.status !== 'configured_valid') throw new ResourceSiteError('authentication');
      if (!row.encryptedPasskey) throw new ResourceSiteError('passkeyRequired');
      if (!adapter.torrentUrl) throw new ResourceSiteError('invalidResponse');
      const passkey = this.secrets.decrypt(row.encryptedPasskey, `${this.context(ownerId, site)}:passkey`);
      currentAiTrace()?.sensitive(passkey);
      currentAiTrace()?.sensitive(encodeURIComponent(passkey));
      const url = adapter.torrentUrl(id, passkey);
      currentAiTrace()?.sensitive(url);
      return url;
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
    return this.run(ownerId, site, 'search', (adapter, session) => {
      currentAiTrace()?.sensitive(input.query ?? '');
      return adapter.search(session, input, signal);
    });
  }

  async detail(ownerId: string, site: string, id: string, signal?: AbortSignal) {
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
      if (row.status !== 'configured_valid') throw new ResourceSiteError('authentication');
      const cookie = this.secrets.decrypt(row.encryptedCookie, this.context(ownerId, site));
      this.protect(cookie);
      try {
        return await action(adapter, await this.http.session(adapter.baseUrl, cookie));
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
