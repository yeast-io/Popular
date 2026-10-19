import type { OpenAIValidation } from '@movie-hub/contract';
import type { Model } from 'mongoose';
import type { OpenAIConfigDocument } from './openai-config.schema.js';
import type { OpenAIConfigRecord, OpenAIConfigStore } from '../../../modules/integrations/openai-settings.types.js';

export class MongoOpenAIConfigStore implements OpenAIConfigStore {
  constructor(
    private readonly configs: Model<OpenAIConfigDocument>
  ) {}
  async find(ownerId: string): Promise<OpenAIConfigRecord | null> {
    const row = await this.configs.findOne({ ownerId }).select('+encryptedApiKey').lean().exec();
    return row
      ? {
          ownerId: row.ownerId.toString(),
          encryptedApiKey: row.encryptedApiKey,
          maskedApiKey: row.maskedApiKey,
          ...(row.model ? { model: row.model } : {}),
          ...(row.validation?.method === 'model_list'
            ? {
                validation: {
                  method: 'model_list' as const,
                  status: row.validation.status as OpenAIValidation['status'],
                  checkedAt: row.validation.checkedAt.toISOString(),
                  models: row.validation.models,
                  ...(row.validation.failureReason
                    ? { failureReason: row.validation.failureReason as NonNullable<OpenAIValidation['failureReason']> }
                    : {}),
                },
              }
            : {}),
        }
      : null;
  }
  async save(record: OpenAIConfigRecord): Promise<void> {
    await this.configs
      .updateOne(
        { ownerId: record.ownerId },
        {
          $set: { ownerId: record.ownerId, encryptedApiKey: record.encryptedApiKey, maskedApiKey: record.maskedApiKey },
          $unset: { validation: 1, model: 1 },
        },
        { upsert: true, runValidators: true },
      )
      .exec();
  }
  async saveValidation(ownerId: string, encryptedApiKey: string, validation: OpenAIValidation): Promise<boolean> {
    const result = await this.configs
      .updateOne({ ownerId, encryptedApiKey }, { $set: { validation } }, { runValidators: true })
      .exec();
    return result.matchedCount === 1;
  }
  async selectModel(ownerId: string, encryptedApiKey: string, model: string): Promise<boolean> {
    const result = await this.configs
      .updateOne(
        {
          ownerId,
          encryptedApiKey,
          'validation.method': 'model_list',
          'validation.status': 'valid',
          'validation.models': model,
        },
        { $set: { model } },
        { runValidators: true },
      )
      .exec();
    return result.matchedCount === 1;
  }
  async delete(ownerId: string): Promise<void> {
    await this.configs.deleteOne({ ownerId }).exec();
  }
}
