import type { AiProvider, AiValidation } from '@movie-hub/contract';
import type { Model } from 'mongoose';
import type { AiConfigDocument } from './ai-config.schema.js';
import type { AiConfigRecord, AiConfigStore } from '../../../modules/integrations/ai-settings.types.js';

export class MongoAiConfigStore implements AiConfigStore {
  constructor(
    private readonly configs: Model<AiConfigDocument>,
    private readonly provider: AiProvider,
    private readonly legacy?: AiConfigStore
  ) {}

  private key(ownerId: string) { return { ownerId, provider: this.provider }; }

  async find(ownerId: string): Promise<AiConfigRecord | null> {
    let row = await this.configs.findOne(this.key(ownerId)).select('+encryptedApiKey').lean().exec();
    if (!row && this.legacy) {
      const previous = await this.legacy.find(ownerId);
      if (previous) {
        // Idempotent lazy import preserves the original OpenAI encryption context.
        try {
          await this.configs.updateOne(this.key(ownerId), { $setOnInsert: {
            ...previous, ...this.key(ownerId), encryptionContextVersion: 1, revision: 0, removed: false,
          } }, { upsert: true, runValidators: true }).exec();
        } catch (error) {
          if (!(error && typeof error === 'object' && 'code' in error && error.code === 11000)) throw error;
        }
        row = await this.configs.findOne(this.key(ownerId)).select('+encryptedApiKey').lean().exec();
      }
    }
    if (!row || row.removed || !row.encryptedApiKey || !row.maskedApiKey) return null;
    return {
      ownerId, encryptedApiKey: row.encryptedApiKey, maskedApiKey: row.maskedApiKey,
      revision: row.revision, encryptionContextVersion: row.encryptionContextVersion,
      ...(row.model ? { model: row.model } : {}),
      ...(row.validation?.method === 'model_list'
        ? { validation: {
            method: 'model_list', status: row.validation.status as AiValidation['status'],
            checkedAt: row.validation.checkedAt.toISOString(), models: row.validation.models,
            ...(row.validation.failureReason ? { failureReason: row.validation.failureReason as NonNullable<AiValidation['failureReason']> } : {}),
          } }
        : {}),
    };
  }

  async save(record: AiConfigRecord, expectedEncryptedApiKey: string | null): Promise<boolean> {
    try {
      const result = await this.configs.updateOne({
        ...this.key(record.ownerId),
        ...(expectedEncryptedApiKey === null ? { encryptedApiKey: { $exists: false } } : { encryptedApiKey: expectedEncryptedApiKey }),
        ...(record.revision === undefined ? {} : { revision: record.revision }),
      }, {
        $set: { ...this.key(record.ownerId), encryptedApiKey: record.encryptedApiKey,
          maskedApiKey: record.maskedApiKey, validation: record.validation, removed: false,
          encryptionContextVersion: 1, ...(record.model ? { model: record.model } : {}) },
        $inc: { revision: 1 },
        ...(!record.model ? { $unset: { model: 1 } } : {}),
      }, { upsert: expectedEncryptedApiKey === null, runValidators: true }).exec();
      return result.matchedCount === 1 || result.upsertedCount === 1;
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 11000) return false;
      throw error;
    }
  }

  async saveValidation(ownerId: string, encryptedApiKey: string, validation: AiValidation, expectedRevision?: number): Promise<boolean> {
    const result = await this.configs.updateOne({ ...this.key(ownerId), encryptedApiKey, removed: false, ...(expectedRevision === undefined ? {} : { revision: expectedRevision }) },
      { $set: { validation }, $inc: { revision: 1 } }, { runValidators: true }).exec();
    return result.matchedCount === 1;
  }

  async selectModel(ownerId: string, encryptedApiKey: string, model: string, expectedRevision?: number): Promise<boolean> {
    const result = await this.configs.updateOne({ ...this.key(ownerId), encryptedApiKey, 'removed': false, ...(expectedRevision === undefined ? {} : { revision: expectedRevision }),
      'validation.status': 'valid', 'validation.method': 'model_list', 'validation.models': model,
    }, { $set: { model }, $inc: { revision: 1 } }, { runValidators: true }).exec();
    return result.matchedCount === 1;
  }

  async delete(ownerId: string): Promise<void> {
    // A credential-free tombstone prevents a racing/restarted legacy import from restoring a deleted key.
    await this.configs.updateOne(this.key(ownerId), {
      $set: { removed: true }, $inc: { revision: 1 },
      $unset: { encryptedApiKey: 1, maskedApiKey: 1, model: 1, validation: 1 },
    }, { upsert: true }).exec();
    await this.legacy?.delete(ownerId);
  }
}
