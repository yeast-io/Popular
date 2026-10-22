import { Schema, type InferSchemaType } from 'mongoose';

const keyOperationSchema = new Schema(
  {
    operationId: { type: String, required: true },
    kind: { type: String, enum: ['generate', 'regenerate', 'revoke'], required: true },
    expectedAuthVersion: { type: Number, required: true },
  },
  { _id: false }
);

export const authorizationChangeSchema = new Schema(
  {
    scope: { type: String, enum: ['key', 'device'], required: true },
    eventId: { type: String, required: true },
    ownerId: { type: String, required: true },
    authVersion: { type: Number, required: true },
    deviceId: String,
    deviceVersion: Number,
    correlationId: { type: String, required: true },
  },
  { _id: false }
);

/** Canonical RCCK definition. Stored ONLY on users.rcck; _id is its ownerId.
 * encryptedKey is AES-GCM ciphertext. Gateway authenticates with keyDigest and never decrypts it.
 * authVersion is account-wide; increment only when the key is replaced/revoked.
 */
export const remoteKeySchema = new Schema(
  {
    keyDigest: { type: String, match: /^[a-f0-9]{64}$/ },
    encryptedKey: String,
    active: { type: Boolean, required: true },
    authVersion: { type: Number, required: true, min: 1, max: Number.MAX_SAFE_INTEGER, validate: Number.isSafeInteger },
    operations: { type: [keyOperationSchema], default: [] },
    pendingGatewayChange: { type: authorizationChangeSchema },
  },
  { _id: false }
);

export const remoteClientUserFields = {
  rcck: { type: remoteKeySchema, select: false },
  remoteDeviceLimit: { type: Number, min: 1, max: Number.MAX_SAFE_INTEGER, validate: Number.isSafeInteger, default: 1 },
};
export function addRemoteClientUserIndexes(schema: Schema): void {
  schema.index(
    { 'rcck.keyDigest': 1 },
    { unique: true, partialFilterExpression: { 'rcck.keyDigest': { $type: 'string' } } }
  );
  schema.index(
    { 'rcck.pendingGatewayChange.eventId': 1 },
    { partialFilterExpression: { 'rcck.pendingGatewayChange.eventId': { $exists: true } } }
  );
}

export type RemoteKeyDocument = InferSchemaType<typeof remoteKeySchema>;
