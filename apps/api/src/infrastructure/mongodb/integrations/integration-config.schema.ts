import { Schema, type Connection, type InferSchemaType, type Types } from 'mongoose';

const integrationConfigSchema = new Schema(
  {
    externalUserId: { type: String },
    ownerId: { type: Schema.Types.ObjectId, required: true, ref: 'User' },
    provider: { type: String, required: true },
    baseUrl: { type: String, required: true },
    webBaseUrl: { type: String },
    encryptedApiKey: { type: String, required: true, select: false },
    verifiedAt: { type: Date },
    lastValidationAt: { type: Date },
    lastFailureType: { type: String },
  },
  { timestamps: true, collection: 'integration_configs' }
);

integrationConfigSchema.index({ ownerId: 1, provider: 1 }, { unique: true });

integrationConfigSchema.index(
  { provider: 1, externalUserId: 1 },
  { unique: true, partialFilterExpression: { externalUserId: { $type: 'string' } } }
);

export type IntegrationConfigDocument = InferSchemaType<typeof integrationConfigSchema> & { ownerId: Types.ObjectId };
export const createIntegrationConfigModel = (connection: Connection) => {
  return connection.model<IntegrationConfigDocument>('IntegrationConfig', integrationConfigSchema);
};
