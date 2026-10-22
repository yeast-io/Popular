import type { Model } from 'mongoose';
import type { IntegrationConfigDocument } from '../integrations/integration-config.schema.js';
import type { ResourceSiteCredentialDocument } from './resource-site-credential.schema.js';
import type { SiteAccountMigrationEntry, SiteAccountMigrationStore } from '../../../modules/resource-sites/site-account-migration.types.js';

export class MongoSiteAccountMigrationStore implements SiteAccountMigrationStore {
  constructor(
    private readonly integrations: Model<IntegrationConfigDocument>,
    private readonly credentials: Model<ResourceSiteCredentialDocument>
  ) {}

  async listPending(): Promise<SiteAccountMigrationEntry[]> {
    const missing = { $not: { $type: 'string' } };
    const [mteam, hdarea] = await Promise.all([
      this.integrations.find({ provider: 'mteam', externalUserId: missing }).select('+encryptedApiKey').lean().exec(),
      this.credentials.find({ site: 'hdarea', externalUserId: missing }).select('+encryptedCookie').lean().exec(),
    ]);
    return [
      ...mteam.map((row): SiteAccountMigrationEntry => ({ ownerId: row.ownerId.toString(), site: 'mteam', encryptedCredential: row.encryptedApiKey })),
      ...hdarea.map((row): SiteAccountMigrationEntry => ({ ownerId: row.ownerId.toString(), site: 'hdarea', encryptedCredential: row.encryptedCookie })),
    ];
  }

  async assign(entry: SiteAccountMigrationEntry, externalUserId: string): Promise<boolean> {
    const pending = { ownerId: entry.ownerId, externalUserId: { $not: { $type: 'string' } } };
    // Never recreate a deleted binding or attach an identity to credentials replaced concurrently.
    const result = entry.site === 'mteam'
      ? await this.integrations.updateOne(
          { ...pending, provider: 'mteam', encryptedApiKey: entry.encryptedCredential },
          { $set: { externalUserId } }
        ).exec()
      : await this.credentials.updateOne(
          { ...pending, site: 'hdarea', encryptedCookie: entry.encryptedCredential },
          { $set: { externalUserId } }
        ).exec();
    return result.matchedCount === 1;
  }
}
