import { remoteRequestSchema, remoteAssociationSchema } from '../remote-downloads/remote-command.schema.js';
import { Schema, type Connection, type InferSchemaType, type Types } from 'mongoose';

const notificationChannelSchema = new Schema(
  { channel: { type: String, required: true }, notified: { type: Boolean, default: false }, messageId: String },
  { _id: false }
);
const notificationIntentSchema = new Schema(
  {
    id: { type: String, required: true },
    epoch: { type: Number, required: true },
    channels: { type: [String], required: true },
    nextRunAt: { type: Date, required: true },
    leaseId: String,
    lockedUntil: Date,
  },
  { _id: false }
);
const notificationTaskSchema = new Schema(
  {
    id: { type: String, required: true },
    epoch: { type: Number, required: true },
    downloaded: { type: Boolean, default: false },
    notified: { type: Boolean, default: false },
    cancelled: { type: Boolean, default: false },
    channels: { type: [notificationChannelSchema], required: true },
    nextRunAt: { type: Date, required: true },
    leaseId: String,
    lockedUntil: Date,
    completedAt: Date,
    lastCheckedAt: Date,
    lastError: String,
  },
  { _id: false }
);
const movieDownloadSchema = new Schema(
  {
    executionMode: { type: String, enum: ['local', 'remote'] },
    remoteRequest: { type: remoteRequestSchema },
    remoteAssociation: { type: remoteAssociationSchema },
    remoteCommandRegistered: Boolean,
    remoteRequestState: String,
    remoteOutcome: String,
    remoteQueueExpiresAt: Date,
    remoteRetryAttempt: Number,
    remoteProjectionRevision: Number,
    remoteStatusSequence: Number,
    remoteStatusState: String,
    notificationIntent: { type: notificationIntentSchema },
    notificationTask: { type: notificationTaskSchema },
    ownerId: { type: Schema.Types.ObjectId, required: true, ref: 'User' },
    tmdbId: { type: Number, min: 1 },
    sourceDetailsUrl: String,
    sourceProvider: { type: String, required: true, enum: ['mteam', 'hdarea'] },
    sourceReleaseId: { type: String, required: true },
    provider: { type: String, required: function () { return this.executionMode !== 'remote'; }, enum: ['qbittorrent', 'transmission'] },
    downloaderInstanceId: { type: String },
    downloaderName: { type: String },
    lookupTag: { type: String, required: true },
    torrentHash: { type: String },
    name: { type: String },
    status: {
      type: String,
      required: true,
      enum: ['submitting', 'downloading', 'paused', 'seeding', 'completed', 'failed', 'missing'],
    },
    progress: { type: Number, required: true, min: 0, max: 100, default: 0 },
    downloadedBytes: { type: Number, min: 0 },
    totalBytes: { type: Number, min: 0 },
    downloadSpeed: { type: Number, min: 0 },
    etaSeconds: { type: Number, min: 0 },
    lastErrorCode: { type: String },
    addedAt: { type: Date },
    lastSyncedAt: { type: Date },
    missingSince: { type: Date },
    expiresAt: { type: Date },
  },
  { timestamps: true, collection: 'movie_downloads' }
);

movieDownloadSchema.index({ executionMode: 1, remoteCommandRegistered: 1 });
movieDownloadSchema.index({ 'executionMode': 1, 'remoteRequest.queueExpiresAt': 1 });
movieDownloadSchema.index(
  { 'remoteRequest.commandId': 1 },
  { unique: true, partialFilterExpression: { 'remoteRequest.commandId': { $type: 'string' } } }
);
movieDownloadSchema.index({ ownerId: 1, tmdbId: 1, sourceProvider: 1, sourceReleaseId: 1 }, { unique: true });
movieDownloadSchema.index({ ownerId: 1, tmdbId: 1, updatedAt: -1 });
movieDownloadSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0, partialFilterExpression: { status: 'missing' } });

movieDownloadSchema.index({
  'notificationTask.cancelled': 1,
  'notificationTask.notified': 1,
  'notificationTask.nextRunAt': 1,
  'notificationTask.lockedUntil': 1,
});
movieDownloadSchema.index({ 'notificationIntent.nextRunAt': 1, 'notificationIntent.lockedUntil': 1 });

export type MovieDownloadDocument = InferSchemaType<typeof movieDownloadSchema> & { ownerId: Types.ObjectId };
export const createMovieDownloadModel = (connection: Connection) => {
  return connection.model<MovieDownloadDocument>('MovieDownload', movieDownloadSchema);
};
