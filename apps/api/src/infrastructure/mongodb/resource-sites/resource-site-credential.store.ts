import type { Model } from 'mongoose';
import type { ResourceSiteCredential, ResourceSiteCredentialStore } from '../../../modules/resource-sites/resource-site.types.js';
import type { ResourceSiteCredentialDocument } from './resource-site-credential.schema.js';
export class MongoResourceSiteCredentialStore implements ResourceSiteCredentialStore {
  constructor(
    private readonly model: Model<ResourceSiteCredentialDocument>
  ) {}
  async find(ownerId: string, site: string): Promise<ResourceSiteCredential | null> {
    const row = await this.model.findOne({ ownerId, site }).select('+encryptedCookie +encryptedPasskey').lean().exec();
    return row ? { ownerId: row.ownerId.toString(), site: row.site, encryptedCookie: row.encryptedCookie,
      ...(row.encryptedPasskey ? { encryptedPasskey: row.encryptedPasskey } : {}),
      version: row.version, verifiedAt: row.verifiedAt,
      status: row.status === 'configured_invalid' ? 'configured_invalid' : 'configured_valid' } : null;
  }
  async save(input: ResourceSiteCredential): Promise<void> {
    await this.model.updateOne({ ownerId: input.ownerId, site: input.site }, { $set: input }, { upsert: true }).exec();
  }
  async invalidate(ownerId: string, site: string, version: string): Promise<void> {
    await this.model.updateOne({ ownerId, site, version }, { $set: { status: 'configured_invalid' } }).exec();
  }
  async delete(ownerId: string, site: string): Promise<void> { await this.model.deleteOne({ ownerId, site }).exec(); }
}
