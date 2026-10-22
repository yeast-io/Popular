import type { Model } from 'mongoose';
import type { IntegrationFailureType, QBittorrentAuthMethod } from '@movie-hub/contract';
import type {
  QBittorrentConfigRecord,
  QBittorrentConfigStore,
} from '../../../modules/integrations/qbittorrent.types.js';
import type { QBittorrentConfigDocument } from './qbittorrent-config.schema.js';

export class MongoQBittorrentConfigStore implements QBittorrentConfigStore {
  constructor(private readonly configs: Model<QBittorrentConfigDocument>) {}

  async find(ownerId: string, downloaderInstanceId?: string): Promise<QBittorrentConfigRecord | null> {
    const row = await this.configs.findOne({ ownerId, ...(downloaderInstanceId ? { downloaderInstanceId } : {}) }).select('+encryptedCredential').lean().exec();
    return row ? toRecord(row) : null;
  }

  async list(ownerId: string): Promise<QBittorrentConfigRecord[]> {
    const rows = await this.configs.find({ ownerId }).select('+encryptedCredential').sort({ createdAt: 1 }).lean().exec();
    return rows.map(toRecord);
  }

  async saveVerified(
    input: QBittorrentConfigRecord & { verifiedAt: Date; lastValidationAt: Date }
  ): Promise<QBittorrentConfigRecord> {
    const row = await this.configs
      .findOneAndUpdate(
        { ownerId: input.ownerId, ...(input.downloaderInstanceId ? { downloaderInstanceId: input.downloaderInstanceId } : {}) },
        {
          $set: {
            baseUrl: input.baseUrl,
            ...(input.downloaderInstanceId ? { downloaderInstanceId: input.downloaderInstanceId } : {}),
            ...(input.name ? { name: input.name } : {}),
            authMethod: input.authMethod,
            encryptedCredential: input.encryptedCredential,
            version: input.version,
            verifiedAt: input.verifiedAt,
            lastValidationAt: input.lastValidationAt,
            ...(input.username ? { username: input.username } : {}),
          },
          $unset: {
            lastFailureType: 1,
            ...(!input.username ? { username: 1 } : {}),
          },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      )
      .select('+encryptedCredential')
      .lean()
      .exec();
    if (!row) throw new Error('qBittorrent config upsert did not return a document');
    return toRecord(row);
  }

  async recordFailure(ownerId: string, attemptedAt: Date, failureType: IntegrationFailureType, downloaderInstanceId?: string): Promise<void> {
    await this.configs
      .updateOne({ ownerId, ...(downloaderInstanceId ? { downloaderInstanceId } : {}) }, { $set: { lastValidationAt: attemptedAt, lastFailureType: failureType } })
      .exec();
  }

  async delete(ownerId: string, downloaderInstanceId?: string): Promise<void> {
    await this.configs.deleteOne({ ownerId, ...(downloaderInstanceId ? { downloaderInstanceId } : {}) }).exec();
  }
}

function toRecord(row: QBittorrentConfigDocument & { _id: unknown }): QBittorrentConfigRecord {
  return {
    ownerId: row.ownerId.toString(),
    ...(row.downloaderInstanceId ? { downloaderInstanceId: row.downloaderInstanceId } : {}),
    ...(row.name ? { name: row.name } : {}),
    baseUrl: row.baseUrl,
    authMethod: row.authMethod as QBittorrentAuthMethod,
    encryptedCredential: row.encryptedCredential,
    ...(row.username ? { username: row.username } : {}),
    ...(row.version ? { version: row.version } : {}),
    ...(row.verifiedAt ? { verifiedAt: row.verifiedAt } : {}),
    ...(row.lastValidationAt ? { lastValidationAt: row.lastValidationAt } : {}),
    ...(row.lastFailureType ? { lastFailureType: row.lastFailureType as IntegrationFailureType } : {}),
  };
}
