import { Schema, type Connection, type InferSchemaType, type Types } from 'mongoose';

const integrationConfigSchema = new Schema(
  {
    ownerId: { type: Schema.Types.ObjectId, required: true, ref: 'User' },
    provider: { type: String, required: true },
    baseUrl: { type: String, required: true },
    webBaseUrl: { type: String },
    encryptedApiKey: { type: String, required: true, select: false },
    verifiedAt: { type: Date },
    lastValidationAt: { type: Date },
    lastFailureType: { type: String },
  },
  { timestamps: true, collection: 'integration_configs' },
);

integrationConfigSchema.index({ ownerId: 1, provider: 1 }, { unique: true });

export type IntegrationConfigDocument = InferSchemaType<typeof integrationConfigSchema> & { ownerId: Types.ObjectId };
export const createIntegrationConfigModel = (connection: Connection) => {
  return connection.model<IntegrationConfigDocument>('IntegrationConfig', integrationConfigSchema);
};
