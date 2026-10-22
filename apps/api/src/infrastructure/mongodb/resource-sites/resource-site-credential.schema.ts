import { Schema, type Connection, type InferSchemaType, type Types } from 'mongoose';

const resourceSiteCredentialSchema = new Schema(
  {
    ownerId: { type: Schema.Types.ObjectId, required: true, ref: 'User' },
    site: { type: String, required: true },
    encryptedCookie: { type: String, required: true, select: false },
    encryptedPasskey: { type: String, select: false },
    version: { type: String, required: true },
    status: { type: String, required: true, enum: ['configured_valid', 'configured_invalid'] },
    verifiedAt: { type: Date, required: true },
  },
  { timestamps: true, collection: 'resource_site_credentials' }
);
resourceSiteCredentialSchema.index({ ownerId: 1, site: 1 }, { unique: true });
export type ResourceSiteCredentialDocument = InferSchemaType<typeof resourceSiteCredentialSchema> & {
  ownerId: Types.ObjectId;
};
export const createResourceSiteCredentialModel = (connection: Connection) => {
  return connection.model<ResourceSiteCredentialDocument>('ResourceSiteCredential', resourceSiteCredentialSchema);
};
