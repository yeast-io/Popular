import { Schema, type Connection, type InferSchemaType, type Model } from 'mongoose';
import type { OpenAIConfigRecord, OpenAIConfigStore } from '../../modules/integrations/openai-settings.service.js';

const schema = new Schema({
  ownerId: { type: Schema.Types.ObjectId, required: true, ref: 'User' },
  encryptedApiKey: { type: String, required: true, select: false },
  maskedApiKey: { type: String, required: true },
}, { timestamps: true, collection: 'openai_configs' });
schema.index({ ownerId: 1 }, { unique: true });
type Document = InferSchemaType<typeof schema>;
export const createOpenAIConfigModel = (connection: Connection) => connection.model('OpenAIConfig', schema);

export class MongoOpenAIConfigStore implements OpenAIConfigStore {
  constructor(private readonly configs: Model<Document>) {}
  async find(ownerId: string): Promise<OpenAIConfigRecord | null> {
    const row = await this.configs.findOne({ ownerId }).select('+encryptedApiKey').lean().exec();
    return row ? { ownerId: row.ownerId.toString(), encryptedApiKey: row.encryptedApiKey, maskedApiKey: row.maskedApiKey } : null;
  }
  async save(record: OpenAIConfigRecord): Promise<void> {
    await this.configs.updateOne({ ownerId: record.ownerId }, { $set: record }, { upsert: true, runValidators: true }).exec();
  }
  async delete(ownerId: string): Promise<void> {
    await this.configs.deleteOne({ ownerId }).exec();
  }
}
