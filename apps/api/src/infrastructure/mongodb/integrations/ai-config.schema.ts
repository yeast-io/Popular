import { Schema, type Connection, type InferSchemaType } from 'mongoose';

const aiConfigSchema = new Schema(
  {
    provider: { type: String, enum: ['openai', 'deepseek', 'claude'], required: true },
    revision: { type: Number, required: true, default: 0 },
    encryptionContextVersion: { type: Number, required: true, default: 1 },
    removed: { type: Boolean, default: false },
    ownerId: { type: Schema.Types.ObjectId, required: true, ref: 'User' },
    encryptedApiKey: { type: String, select: false },
    maskedApiKey: { type: String },
    model: { type: String },
    validation: {
      type: new Schema(
        {
          status: { type: String, enum: ['valid', 'failed'], required: true },
          method: { type: String, enum: ['model_lookup', 'model_list'], required: true },
          checkedAt: { type: Date, required: true },
          models: { type: [String], default: [] },
          failureReason: {
            type: String,
            enum: [
              'authentication',
              'quota',
              'rate_limit',
              'model',
              'timeout',
              'network',
              'invalid_response',
              'request_failed',
            ],
          },
        },
        { _id: false }
      ),
    },
  },
  { timestamps: true, collection: 'ai_configs' }
);
aiConfigSchema.index({ ownerId: 1, provider: 1 }, { unique: true });
export const createAiConfigModel = (connection: Connection) => {
  return connection.model('AiConfig', aiConfigSchema);
};

export type AiConfigDocument = InferSchemaType<typeof aiConfigSchema>;
