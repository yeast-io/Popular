import { Schema, type Connection, type InferSchemaType, type Types } from 'mongoose';

const movieDownloadSchema = new Schema({
  ownerId: { type: Schema.Types.ObjectId, required: true, ref: 'User' },
  tmdbId: { type: Number, required: true, min: 1 },
  sourceProvider: { type: String, required: true, enum: ['mteam'] },
  sourceReleaseId: { type: String, required: true },
  provider: { type: String, required: true, enum: ['qbittorrent', 'transmission'] },
  lookupTag: { type: String, required: true },
  torrentHash: { type: String },
  name: { type: String },
  status: { type: String, required: true, enum: ['submitting', 'downloading', 'paused', 'seeding', 'completed', 'failed', 'missing'] },
  progress: { type: Number, required: true, min: 0, max: 100, default: 0 },
  downloadedBytes: { type: Number, min: 0 },
  totalBytes: { type: Number, min: 0 },
  downloadSpeed: { type: Number, min: 0 },
  etaSeconds: { type: Number, min: 0 },
  lastErrorCode: { type: String },
  addedAt: { type: Date },
  lastSyncedAt: { type: Date },
}, { timestamps: true, collection: 'movie_downloads' });

movieDownloadSchema.index(
  { ownerId: 1, tmdbId: 1, sourceProvider: 1, sourceReleaseId: 1 },
  { unique: true },
);
movieDownloadSchema.index({ ownerId: 1, tmdbId: 1, updatedAt: -1 });

export type MovieDownloadDocument = InferSchemaType<typeof movieDownloadSchema> & { ownerId: Types.ObjectId };
export const createMovieDownloadModel = (connection: Connection) =>
  connection.model<MovieDownloadDocument>('MovieDownload', movieDownloadSchema);
