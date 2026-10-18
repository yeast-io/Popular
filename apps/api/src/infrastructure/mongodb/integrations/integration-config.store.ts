import type { Model } from 'mongoose';
import type { IntegrationFailureType } from '@movie-hub/contract';
import type { IntegrationConfigRecord, IntegrationConfigStore } from '../../../modules/integrations/integration.types.js';
import type { IntegrationConfigDocument } from './integration-config.schema.js';

export class MongoIntegrationConfigStore implements IntegrationConfigStore {
  constructor(
    private readonly configs: Model<IntegrationConfigDocument>
  )
  {
  }

  async find(ownerId: string, provider: 'mteam'): Promise<IntegrationConfigRecord | null> {
    const row = await this.configs.findOne({ ownerId, provider }).select('+encryptedApiKey').lean().exec();
    return row ? toRecord(row) : null;
  }

  async saveVerified(input: IntegrationConfigRecord & { verifiedAt: Date; lastValidationAt: Date }): Promise<IntegrationConfigRecord> {
    const row = await this.configs.findOneAndUpdate(
      { ownerId: input.ownerId, provider: input.provider },
      {
        $set: {
          baseUrl: input.baseUrl,
          webBaseUrl: input.webBaseUrl,
          encryptedApiKey: input.encryptedApiKey,
          verifiedAt: input.verifiedAt,
          lastValidationAt: input.lastValidationAt,
        },
        $unset: { lastFailureType: 1 },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    ).select('+encryptedApiKey').lean().exec();
    if (!row) throw new Error('Integration config upsert did not return a document');
    return toRecord(row);
  }

  async recordFailure(ownerId: string, provider: 'mteam', attemptedAt: Date, failureType: IntegrationFailureType): Promise<void> {
    await this.configs.updateOne(
      { ownerId, provider },
      { $set: { lastValidationAt: attemptedAt, lastFailureType: failureType } },
    ).exec();
  }

  async delete(ownerId: string, provider: 'mteam'): Promise<void> {
    await this.configs.deleteOne({ ownerId, provider }).exec();
  }
}

function toRecord(row: IntegrationConfigDocument & { _id: unknown }): IntegrationConfigRecord {
  return {
    ownerId: row.ownerId.toString(),
    provider: row.provider as 'mteam',
    baseUrl: row.baseUrl,
    ...(row.webBaseUrl ? { webBaseUrl: row.webBaseUrl } : {}),
    encryptedApiKey: row.encryptedApiKey,
    ...(row.verifiedAt ? { verifiedAt: row.verifiedAt } : {}),
    ...(row.lastValidationAt ? { lastValidationAt: row.lastValidationAt } : {}),
    ...(row.lastFailureType ? { lastFailureType: row.lastFailureType as IntegrationFailureType } : {}),
  };
}
