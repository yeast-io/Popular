import { Schema, type Connection, type InferSchemaType, type Types } from 'mongoose';

const authIdentitySchema = new Schema(
  {
    ownerId: { type: Schema.Types.ObjectId, required: true, ref: 'User' },
    provider: { type: String, required: true, enum: ['password', 'google'] },
    providerSubject: { type: String, required: true },
    providerEmail: { type: String, trim: true, lowercase: true },
  },
  { timestamps: true, collection: 'auth_identities' }
);

authIdentitySchema.index({ provider: 1, providerSubject: 1 }, { unique: true });
authIdentitySchema.index({ ownerId: 1, provider: 1 }, { unique: true });

export type AuthIdentityDocument = InferSchemaType<typeof authIdentitySchema> & { ownerId: Types.ObjectId };
export const createAuthIdentityModel = (connection: Connection) => {
  return connection.model<AuthIdentityDocument>('AuthIdentity', authIdentitySchema);
};
