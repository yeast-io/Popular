import type { Model } from 'mongoose';
import type { IntegrationFailureType, QBittorrentAuthMethod } from '@movie-hub/contract';
import type { QBittorrentConfigRecord, QBittorrentConfigStore } from '../../../modules/integrations/qbittorrent.types.js';
import type { QBittorrentConfigDocument } from './qbittorrent-config.schema.js';

export class MongoQBittorrentConfigStore implements QBittorrentConfigStore {
  constructor(
    private readonly configs: Model<QBittorrentConfigDocument>
  ) {}

  async find(ownerId: string): Promise<QBittorrentConfigRecord | null> {
    const row = await this.configs.findOne({ ownerId }).select('+encryptedCredential').lean().exec();
    return row ? toRecord(row) : null;
  }

  async saveVerified(
    input: QBittorrentConfigRecord & { verifiedAt: Date; lastValidationAt: Date },
  ): Promise<QBittorrentConfigRecord> {
    const row = await this.configs
      .findOneAndUpdate(
        { ownerId: input.ownerId },
        {
          $set: {
            baseUrl: input.baseUrl,
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
        { upsert: true, new: true, setDefaultsOnInsert: true },
      )
      .select('+encryptedCredential')
      .lean()
      .exec();
    if (!row) throw new Error('qBittorrent config upsert did not return a document');
    return toRecord(row);
  }

  async recordFailure(ownerId: string, attemptedAt: Date, failureType: IntegrationFailureType): Promise<void> {
    await this.configs
      .updateOne({ ownerId }, { $set: { lastValidationAt: attemptedAt, lastFailureType: failureType } })
      .exec();
  }

  async delete(ownerId: string): Promise<void> {
    await this.configs.deleteOne({ ownerId }).exec();
  }
}

function toRecord(row: QBittorrentConfigDocument & { _id: unknown }): QBittorrentConfigRecord {
  return {
    ownerId: row.ownerId.toString(),
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
