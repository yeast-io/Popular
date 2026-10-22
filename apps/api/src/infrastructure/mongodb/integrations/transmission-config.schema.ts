import { Schema, type Connection, type InferSchemaType, type Types } from 'mongoose';

const transmissionConfigSchema = new Schema(
  {
    ownerId: { type: Schema.Types.ObjectId, required: true, ref: 'User', unique: true },
    baseUrl: { type: String, required: true },
    username: { type: String, required: true },
    encryptedCredential: { type: String, required: true, select: false },
    version: { type: String },
    verifiedAt: { type: Date },
    lastValidationAt: { type: Date },
    lastFailureType: { type: String },
  },
  { timestamps: true, collection: 'transmission_configs' }
);

export type TransmissionConfigDocument = InferSchemaType<typeof transmissionConfigSchema> & { ownerId: Types.ObjectId };
export const createTransmissionConfigModel = (connection: Connection) => {
  return connection.model<TransmissionConfigDocument>('TransmissionConfig', transmissionConfigSchema);
};
