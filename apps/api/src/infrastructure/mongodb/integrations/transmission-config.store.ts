import type { Model } from 'mongoose';
import type { IntegrationFailureType } from '@movie-hub/contract';
import type { TransmissionConfigRecord, TransmissionConfigStore } from '../../../modules/integrations/transmission.types.js';
import type { TransmissionConfigDocument } from './transmission-config.schema.js';

export class MongoTransmissionConfigStore implements TransmissionConfigStore {
  constructor(
    private readonly configs: Model<TransmissionConfigDocument>
  ) {}

  async find(ownerId: string): Promise<TransmissionConfigRecord | null> {
    const row = await this.configs.findOne({ ownerId }).select('+encryptedCredential').lean().exec();
    return row ? toRecord(row) : null;
  }

  async saveVerified(
    input: TransmissionConfigRecord & { verifiedAt: Date; lastValidationAt: Date },
  ): Promise<TransmissionConfigRecord> {
    const row = await this.configs
      .findOneAndUpdate(
        { ownerId: input.ownerId },
        {
          $set: {
            baseUrl: input.baseUrl,
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
        { upsert: true, new: true, setDefaultsOnInsert: true },
      )
      .select('+encryptedCredential')
      .lean()
      .exec();
    if (!row) throw new Error('Transmission config upsert did not return a document');
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

function toRecord(row: TransmissionConfigDocument & { _id: unknown }): TransmissionConfigRecord {
  return {
    ownerId: row.ownerId.toString(),
    baseUrl: row.baseUrl,
    encryptedCredential: row.encryptedCredential,
    username: row.username,
    ...(row.version ? { version: row.version } : {}),
    ...(row.verifiedAt ? { verifiedAt: row.verifiedAt } : {}),
    ...(row.lastValidationAt ? { lastValidationAt: row.lastValidationAt } : {}),
    ...(row.lastFailureType ? { lastFailureType: row.lastFailureType as IntegrationFailureType } : {}),
  };
}
