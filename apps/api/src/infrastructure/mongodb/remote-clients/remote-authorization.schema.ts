import { Schema, type Connection, type InferSchemaType } from 'mongoose';

import { deviceKeysSchema } from './remote-device.schema.js';

/** Legacy pre-users RCCK layout. Read only for migration; Gateway must use users.rcck and remote devices.
 * Historical ownership: Popular owns authorization/revocation; Gateway owns first binding.
 * Binding must atomically match active + keyDigest + authVersion + absent deviceId.
 * All writes patch fields; never replace this document or write private device keys.
 */
export const remoteAuthorizationSchema = new Schema(
  {
    ownerId: { type: Schema.Types.ObjectId, required: true, ref: 'User' },
    keyDigest: { type: String, required: true, select: false, match: /^[a-f0-9]{64}$/ },
    authVersion: { type: Number, required: true, min: 1 },
    active: { type: Boolean, required: true, default: true },
    deviceId: { type: String },
    keys: { type: deviceKeysSchema, select: false },
    boundAt: Date,
    migratedToUsers: Boolean,
    // Same-document durable notification; clearing must match the version sent.
    pendingGatewayVersion: Number,
    pendingCorrelationId: String,
    operations: {
      type: [
        new Schema(
          {
            operationId: { type: String, required: true },
            kind: { type: String, enum: ['generate', 'regenerate', 'unbind'], required: true },
            expectedAuthVersion: { type: Number, required: true },
          },
          { _id: false }
        ),
      ],
      default: [],
    },
    lastOperationId: { type: String, required: true },
    lastOperationKind: { type: String, enum: ['generate', 'regenerate', 'unbind'], required: true },
    lastExpectedAuthVersion: { type: Number, required: true },
  },
  { timestamps: true, collection: 'remote_client_authorizations', autoCreate: false, autoIndex: false }
);
remoteAuthorizationSchema.index({ ownerId: 1 }, { unique: true });
remoteAuthorizationSchema.index({ keyDigest: 1 }, { unique: true });
remoteAuthorizationSchema.index(
  { deviceId: 1 },
  { unique: true, partialFilterExpression: { deviceId: { $type: 'string' } } }
);
remoteAuthorizationSchema.index(
  { pendingGatewayVersion: 1 },
  { partialFilterExpression: { pendingGatewayVersion: { $exists: true } } }
);
export type RemoteAuthorizationDocument = InferSchemaType<typeof remoteAuthorizationSchema>;
export const createRemoteAuthorizationModel = (connection: Connection) => {
  return (
    (connection.models.RemoteClientAuthorization as ReturnType<typeof registerModel> | undefined)
    ?? registerModel(connection)
  );
};
function registerModel(connection: Connection) {
  return connection.model('RemoteClientAuthorization', remoteAuthorizationSchema);
}

export * from './remote-key.schema.js';
export * from './remote-device.schema.js';

export * from './remote-device.domain.js';
