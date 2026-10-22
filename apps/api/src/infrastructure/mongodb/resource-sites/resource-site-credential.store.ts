import { siteAccountInUse, siteAccountIdentityPending } from '../../../modules/resource-sites/site-account.errors.js';
import type { Model } from 'mongoose';
import type {
  ResourceSiteCredential,
  ResourceSiteCredentialStore,
} from '../../../modules/resource-sites/resource-site.types.js';
import type { ResourceSiteCredentialDocument } from './resource-site-credential.schema.js';

export class MongoResourceSiteCredentialStore implements ResourceSiteCredentialStore {
  constructor(private readonly model: Model<ResourceSiteCredentialDocument>) {}

  async find(ownerId: string, site: string): Promise<ResourceSiteCredential | null> {
    const row = await this.model.findOne({ ownerId, site }).select('+encryptedCookie +encryptedPasskey').lean().exec();
    return row
      ? {
          ownerId: row.ownerId.toString(),
          site: row.site,
          ...(row.externalUserId ? { externalUserId: row.externalUserId } : {}),
          encryptedCookie: row.encryptedCookie,
          ...(row.encryptedPasskey ? { encryptedPasskey: row.encryptedPasskey } : {}),
          version: row.version,
          verifiedAt: row.verifiedAt,
          status: row.status === 'configured_invalid' ? 'configured_invalid' : 'configured_valid',
        }
      : null;
  }

  async save(input: ResourceSiteCredential & { externalUserId: string }): Promise<void> {
    const retainedBinding = await this.model.exists({
      ownerId: input.ownerId, site: input.site,
      $or: [{ externalUserId: input.externalUserId }, { externalUserId: { $not: { $type: 'string' } } }],
    });
    if (!retainedBinding && await this.model.exists({ site: input.site, ownerId: { $ne: input.ownerId }, externalUserId: { $not: { $type: 'string' } } }))
      throw siteAccountIdentityPending();
    try {
      await this.model.updateOne({ ownerId: input.ownerId, site: input.site }, { $set: input }, { upsert: true }).exec();
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 11000) throw siteAccountInUse(error);
      throw error;
    }
  }

  async invalidate(ownerId: string, site: string, version: string): Promise<void> {
    await this.model.updateOne({ ownerId, site, version }, { $set: { status: 'configured_invalid' } }).exec();
  }

  async delete(ownerId: string, site: string): Promise<void> {
    await this.model.deleteOne({ ownerId, site }).exec();
  }
}
