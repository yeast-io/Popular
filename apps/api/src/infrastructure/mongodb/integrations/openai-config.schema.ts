import { Schema, type Connection, type InferSchemaType } from 'mongoose';

const openAIConfigSchema = new Schema(
  {
    ownerId: { type: Schema.Types.ObjectId, required: true, ref: 'User' },
    encryptedApiKey: { type: String, required: true, select: false },
    maskedApiKey: { type: String, required: true },
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
  { timestamps: true, collection: 'openai_configs' }
);
openAIConfigSchema.index({ ownerId: 1 }, { unique: true });
export const createOpenAIConfigModel = (connection: Connection) => {
  return connection.model('OpenAIConfig', openAIConfigSchema);
};

export type OpenAIConfigDocument = InferSchemaType<typeof openAIConfigSchema>;
