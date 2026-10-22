import type { Model } from 'mongoose';
import type { IntegrationFailureType } from '@movie-hub/contract';
import type {
  TransmissionConfigRecord,
  TransmissionConfigStore,
} from '../../../modules/integrations/transmission.types.js';
import type { TransmissionConfigDocument } from './transmission-config.schema.js';

export class MongoTransmissionConfigStore implements TransmissionConfigStore {
  constructor(private readonly configs: Model<TransmissionConfigDocument>) {}

  async find(ownerId: string, downloaderInstanceId?: string): Promise<TransmissionConfigRecord | null> {
    const row = await this.configs.findOne({ ownerId, ...(downloaderInstanceId ? { downloaderInstanceId } : {}) }).select('+encryptedCredential').lean().exec();
    return row ? toRecord(row) : null;
  }

  async list(ownerId: string): Promise<TransmissionConfigRecord[]> {
    const rows = await this.configs.find({ ownerId }).select('+encryptedCredential').sort({ createdAt: 1 }).lean().exec();
    return rows.map(toRecord);
  }

  async saveVerified(
    input: TransmissionConfigRecord & { verifiedAt: Date; lastValidationAt: Date }
  ): Promise<TransmissionConfigRecord> {
    const row = await this.configs
      .findOneAndUpdate(
        { ownerId: input.ownerId, ...(input.downloaderInstanceId ? { downloaderInstanceId: input.downloaderInstanceId } : {}) },
        {
          $set: {
            baseUrl: input.baseUrl,
            ...(input.downloaderInstanceId ? { downloaderInstanceId: input.downloaderInstanceId } : {}),
            ...(input.name ? { name: input.name } : {}),
            encryptedCredential: input.encryptedCredential,
            version: input.version,
            verifiedAt: input.verifiedAt,
            lastValidationAt: input.lastValidationAt,
            username: input.username,
          },
          $unset: {
            lastFailureType: 1,
          },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      )
      .select('+encryptedCredential')
      .lean()
      .exec();
    if (!row) throw new Error('Transmission config upsert did not return a document');
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

function toRecord(row: TransmissionConfigDocument & { _id: unknown }): TransmissionConfigRecord {
  return {
    ownerId: row.ownerId.toString(),
    ...(row.downloaderInstanceId ? { downloaderInstanceId: row.downloaderInstanceId } : {}),
    ...(row.name ? { name: row.name } : {}),
    baseUrl: row.baseUrl,
    encryptedCredential: row.encryptedCredential,
    username: row.username,
    ...(row.version ? { version: row.version } : {}),
    ...(row.verifiedAt ? { verifiedAt: row.verifiedAt } : {}),
    ...(row.lastValidationAt ? { lastValidationAt: row.lastValidationAt } : {}),
    ...(row.lastFailureType ? { lastFailureType: row.lastFailureType as IntegrationFailureType } : {}),
  };
}
