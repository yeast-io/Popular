import { Schema, type Connection, type InferSchemaType } from 'mongoose';

const syncJobSchema = new Schema(
  {
    key: { type: String, required: true },
    enabled: { type: Boolean, required: true, default: true },
    intervalSeconds: { type: Number, required: true, min: 60 },
    nextRunAt: { type: Date, required: true },
    leaseOwner: { type: String },
    leaseExpiresAt: { type: Date },
    lastStartedAt: { type: Date },
    lastSucceededAt: { type: Date },
    consecutiveFailures: { type: Number, required: true, default: 0, min: 0 },
    lastErrorSummary: { type: String, maxlength: 1_000 },
  },
  { timestamps: true, collection: 'sync_jobs' }
);

syncJobSchema.index({ key: 1 }, { unique: true });
syncJobSchema.index({ enabled: 1, nextRunAt: 1, leaseExpiresAt: 1 });

export type SyncJobDocument = InferSchemaType<typeof syncJobSchema>;
export const createSyncJobModel = (connection: Connection) => {
  return connection.model<SyncJobDocument>('SyncJob', syncJobSchema);
};
