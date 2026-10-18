import { Schema, type Connection } from 'mongoose';

export function createPreferenceModels(connection: Connection) {
  const profile = new Schema({
    ownerId: { type: String, required: true, unique: true },
    version: { type: Number, default: 0 },
    data: { type: Schema.Types.Mixed, required: true },
    appliedJobs: { type: [String], default: [] },
  }, { timestamps: true });
  const job = new Schema({
    key: { type: String, required: true, unique: true },
    ownerId: { type: String, required: true },
    kind: { type: String, required: true },
    evidence: { type: Schema.Types.Mixed, required: true },
    fingerprint: String,
    status: { type: String, default: 'pending' },
    attempts: { type: Number, default: 0 },
    leaseId: String,
    leaseUntil: Date,
    activeOwner: String,
    nextAt: { type: Date, default: Date.now },
    error: { type: String, default: null },
  }, { timestamps: true });
  job.index({ status: 1, nextAt: 1, leaseUntil: 1 });
  job.index({ ownerId: 1, createdAt: -1 });
  job.index({ activeOwner: 1 }, { unique: true, sparse: true });
  return { profiles: connection.model('TasteProfile', profile), jobs: connection.model('PreferenceJob', job) };
}
