import { AiTrace, aiStep, currentAiTrace, withAiTrace } from '../../infrastructure/logging/ai-trace.js';
import type { ResourceSiteHttpClientPort } from './resource-site.types.js';
import type { MTeamVerifier } from '../integrations/integration.types.js';
import { integrationSecretContext } from '../integrations/integration.service.js';
import type { SecretCrypto } from '../integrations/secret-crypto.js';
import type { SiteAccountMigrationStore } from './site-account-migration.types.js';
import type { ResourceSiteAdapter, ResourceSiteDiagnostics } from './resource-site.types.js';

export class SiteAccountMigrationService {
  constructor(
    private readonly store: SiteAccountMigrationStore,
    private readonly mteam: MTeamVerifier,
    private readonly mteamBaseUrl: string,
    private readonly registry: ReadonlyMap<string, ResourceSiteAdapter>,
    private readonly http: ResourceSiteHttpClientPort,
    private readonly secrets: SecretCrypto,
    private readonly diagnostics: ResourceSiteDiagnostics
  ) {}

  async migrate(): Promise<{ migrated: number; unresolved: number }> {
    const trace = new AiTrace(this.diagnostics.logger, {}, '', 'site-account.migration', this.diagnostics.verbose);
    return withAiTrace(trace, async () => {
      const entries = await aiStep('site-account.migration.load', () => this.store.listPending());
      let migrated = 0;
      let unresolved = 0;
      for (const entry of entries) {
        const itemTrace = new AiTrace(this.diagnostics.logger, {
          correlationId: trace.correlationId, ownerId: entry.ownerId, site: entry.site,
        }, '', 'site-account.migration.entry', this.diagnostics.verbose);
        await withAiTrace(itemTrace, async () => {
          try {
            const context = entry.site === 'mteam'
              ? integrationSecretContext(entry.ownerId, 'mteam')
              : `movie-hub:resource-site:hdarea:owner:${entry.ownerId}`;
            const credential = this.secrets.decrypt(entry.encryptedCredential, context);
            itemTrace.sensitive(credential);
            if (entry.site === 'hdarea')
              for (const pair of credential.split(';')) itemTrace.sensitive(pair.slice(pair.indexOf('=') + 1).trim());
            const externalUserId = await aiStep('site-account.migration.verify', async () => {
              if (entry.site === 'mteam') return this.mteam.verify(this.mteamBaseUrl, credential);
              const adapter = this.registry.get('hdarea');
              if (!adapter) throw new Error('HDArea adapter is unavailable');
              return adapter.verify(await this.http.session(adapter.baseUrl, credential));
            });
            currentAiTrace()?.sensitive(externalUserId);
            const assigned = await aiStep('site-account.migration.assign', () => this.store.assign(entry, externalUserId));
            if (assigned) migrated++;
            else unresolved++;
          } catch (error) {
            unresolved++;
            // Invalid credentials and historical conflicts remain intact for their owners to resolve.
            itemTrace.fail(error, { outcome: 'unresolved' });
          }
        });
      }
      trace.event('site-account.migration.completed', { migrated, unresolved });
      return { migrated, unresolved };
    });
  }
}
