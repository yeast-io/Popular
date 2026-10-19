import { Schema, type Connection, type InferSchemaType, type Types } from 'mongoose';

const movieResourceSyncBatchSchema = new Schema(
  {
    ownerId: { type: Schema.Types.ObjectId, required: true, ref: 'User' },
    status: { type: String, required: true, enum: ['queued', 'running', 'paused', 'completed', 'failed', 'cancelled'] },
    active: { type: Boolean, required: true },
    movieIds: { type: [Number], required: true, default: [] },
    cursor: { type: Number, required: true, min: 0, default: 0 },
    total: { type: Number, required: true, min: 0 },
    completed: { type: Number, required: true, min: 0, default: 0 },
    available: { type: Number, required: true, min: 0, default: 0 },
    unavailable: { type: Number, required: true, min: 0, default: 0 },
    unmatchable: { type: Number, required: true, min: 0, default: 0 },
    failed: { type: Number, required: true, min: 0, default: 0 },
    force: { type: Boolean, required: true, default: false },
    rateLimitRetries: { type: Number, required: true, min: 0, default: 0 },
    resumeAt: { type: Date },
    needsAction: { type: String, enum: ['update_api_key'] },
  },
  { timestamps: true, collection: 'movie_resource_sync_batches', versionKey: false },
);

movieResourceSyncBatchSchema.index(
  { ownerId: 1, active: 1 },
  { unique: true, partialFilterExpression: { active: true } },
);
movieResourceSyncBatchSchema.index({ active: 1, status: 1, resumeAt: 1 });
movieResourceSyncBatchSchema.index({ ownerId: 1, createdAt: -1 });

export type MovieResourceSyncBatchDocument = InferSchemaType<typeof movieResourceSyncBatchSchema> & {
  _id: Types.ObjectId;
  ownerId: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
};

export const createMovieResourceSyncBatchModel = (connection: Connection) => {
  return connection.model<MovieResourceSyncBatchDocument>('MovieResourceSyncBatch', movieResourceSyncBatchSchema);
};
