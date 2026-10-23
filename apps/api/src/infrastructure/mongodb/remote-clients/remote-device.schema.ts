import { Schema, type Connection, type InferSchemaType } from 'mongoose';
import { authorizationChangeSchema } from './remote-key.schema.js';

const publicKeySchema = new Schema(
  {
    kty: { type: String, required: true },
    crv: String,
    x: String,
    n: String,
    e: String,
  },
  { _id: false }
);
export const deviceKeysSchema = new Schema(
  {
    signingKey: { type: publicKeySchema, required: true },
    encryptionKey: { type: publicKeySchema, required: true },
  },
  { _id: false }
);
const deviceOperationSchema = new Schema(
  {
    operationId: { type: String, required: true },
    expectedAuthVersion: { type: Number, required: true },
    expectedDeviceVersion: { type: Number, required: true },
  },
  { _id: false }
);

/** One binding generation per deviceId. Popular creates bindings on Gateway proof verification after explicit user action.
 * Never reactivate an unbound deviceId; an explicit new bind creates a new deviceId.
 * Effective authorization requires users.rcck.active AND matching authVersion AND status=bound.
 */
export const remoteDeviceSchema = new Schema(
  {
    ownerId: { type: Schema.Types.ObjectId, required: true, ref: 'User' },
    deviceId: { type: String, required: true },
    bindingOperationId: String,
    bindingDigest: String,
    keyFingerprint: { type: String, required: true, match: /^[a-f0-9]{64}$/ },
    authVersion: { type: Number, required: true, min: 1, max: Number.MAX_SAFE_INTEGER, validate: Number.isSafeInteger },
    deviceVersion: {
      type: Number,
      required: true,
      min: 1,
      max: Number.MAX_SAFE_INTEGER,
      validate: Number.isSafeInteger,
      default: 1,
    },
    slot: { type: Number, required: true, min: 1, max: Number.MAX_SAFE_INTEGER, validate: Number.isSafeInteger },
    status: { type: String, enum: ['bound', 'unbound'], required: true, default: 'bound' },
    // Conservative placeholders until Gateway/Agent status reporting is integrated.
    isAgentOnline: { type: Boolean, required: true, default: false },
    isAgentDownloaderOnline: { type: Boolean, required: true, default: false },
    statusCheckedAt: Date,
    downloaderType: { type: String, enum: ['qbittorrent', 'transmission'] },
    downloaderInstanceId: String,
    keys: { type: deviceKeysSchema, required: true, select: false },
    boundAt: { type: Date, required: true },
    unboundAt: Date,
    operations: { type: [deviceOperationSchema], default: [] },
    pendingGatewayChange: { type: authorizationChangeSchema },
  },
  { collection: 'remote_client_devices', timestamps: true }
);
remoteDeviceSchema.index(
  { ownerId: 1, bindingOperationId: 1 },
  { unique: true, partialFilterExpression: { bindingOperationId: { $type: 'string' } } }
);
remoteDeviceSchema.index({ deviceId: 1 }, { unique: true });
// Popular must claim a slot in [1, users.remoteDeviceLimit]. No count-then-insert quota race.
remoteDeviceSchema.index(
  { ownerId: 1, authVersion: 1, slot: 1 },
  { unique: true, partialFilterExpression: { status: 'bound' } }
);
remoteDeviceSchema.index(
  { ownerId: 1, authVersion: 1, keyFingerprint: 1 },
  { unique: true, partialFilterExpression: { status: 'bound' } }
);
remoteDeviceSchema.index({ ownerId: 1, authVersion: 1, status: 1 });
remoteDeviceSchema.index(
  { 'pendingGatewayChange.eventId': 1 },
  { partialFilterExpression: { 'pendingGatewayChange.eventId': { $exists: true } } }
);
export type RemoteDeviceDocument = InferSchemaType<typeof remoteDeviceSchema>;
export const createRemoteDeviceModel = (connection: Connection) => {
  return connection.model('RemoteClientDevice', remoteDeviceSchema);
};
