import { createResourceDownloadLimitModel } from './resource-download-limit.schema.js';
import { Schema, type Connection } from 'mongoose';
import type { CommandRecord } from '@movie-hub/contract';

const evidence = new Schema(
  { downloaderType: String, instanceId: String, torrentHash: String, taskId: String, marker: String },
  { _id: false }
);
const result = new Schema({ commandId: String, executionId: String, outcome: String, evidence }, { _id: false });
export const remoteRequestSchema = new Schema(
  {
    displayTitle: String,
    commandId: String,
    deviceId: String,
    authVersion: Number,
    deviceVersion: Number,
    source: String,
    resourceId: String,
    correlationId: String,
    digest: String,
    createdAt: Number,
    expiresAt: Number,
    queueExpiresAt: Number,
    targetDownloader: new Schema({ downloaderType: String, instanceId: String }, { _id: false }),
    deliverySessionId: String,
    deliveryMessageId: String,
  },
  { _id: false }
);
export const remoteAssociationSchema = new Schema(
  {
    commandId: String,
    executionId: String,
    deviceId: String,
    authVersion: Number,
    deviceVersion: Number,
    downloaderType: String,
    instanceId: String,
    torrentHash: String,
    taskId: String,
    marker: String,
  },
  { _id: false }
);
export const remoteCommandSchema = new Schema<CommandRecord>(
  {
    commandId: { type: String, required: true, unique: true },
    downloadId: { type: String, required: true },
    ownerId: { type: String, required: true },
    deviceId: { type: String, required: true },
    authVersion: { type: Number, required: true },
    deviceVersion: { type: Number, required: true },
    source: { type: String, required: true },
    resourceId: { type: String, required: true },
    correlationId: { type: String, required: true },
    revision: { type: Number, required: true },
    digest: { type: String, required: true },
    state: { type: String, required: true },
    createdAt: { type: Number, required: true },
    expiresAt: { type: Number, required: true },
    deliverySessionId: { type: String, required: true },
    deliveryMessageId: { type: String, required: true },
    retiredAt: Number,
    queueExpiresAt: Number,
    nextAttemptAt: Number,
    retryAttempt: Number,
    lastErrorCode: String,
    limitDetectedAt: Number,
    lastAttemptAt: Number,
    targetDownloader: new Schema({ downloaderType: String, instanceId: String }, { _id: false }),
    envelope: String,
    torrentHash: String,
    executionId: String,
    grantSessionId: String,
    grantExpiresAt: Number,
    executionDownloader: new Schema({ downloaderType: String, instanceId: String }, { _id: false }),
    result,
    resultDigest: String,
    projected: Boolean,
    closeId: String,
  },
  { collection: 'remote_client_commands', versionKey: false }
);
remoteCommandSchema.index({ queueExpiresAt: 1 });
remoteCommandSchema.index({ retiredAt: 1 });
remoteCommandSchema.index({ ownerId: 1, deviceId: 1, authVersion: 1, deviceVersion: 1, queueExpiresAt: 1, commandId: 1 });
remoteCommandSchema.index({ downloadId: 1, createdAt: 1 });
remoteCommandSchema.index({ deviceId: 1, state: 1, expiresAt: 1 });
remoteCommandSchema.index({ state: 1, nextAttemptAt: 1, queueExpiresAt: 1 });
remoteCommandSchema.index({ projected: 1, state: 1 });
export const remoteReceiptSchema = new Schema(
  { key: { type: String, required: true, unique: true }, digest: { type: String, required: true } },
  { collection: 'remote_client_event_receipts', versionKey: false }
);
export function createRemoteCommandModels(connection: Connection) {
  return {
    limits: createResourceDownloadLimitModel(connection),
    commands: connection.model('RemoteClientCommand', remoteCommandSchema),
    receipts: connection.model('RemoteClientEventReceipt', remoteReceiptSchema),
  };
}
export type RemoteCommandModels = ReturnType<typeof createRemoteCommandModels>;
