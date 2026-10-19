import { Schema, type Connection } from 'mongoose';

export function createRecommendationModel(connection: Connection) {
  const schema = new Schema(
    {
      ownerId: { type: String, required: true },
      conversation: { type: String, required: true },
      data: { type: Schema.Types.Mixed, required: true },
      leaseId: String,
      leaseUntil: Date,
    },
    { timestamps: true },
  );
  schema.index({ ownerId: 1, conversation: 1 }, { unique: true });
  // Preserve the existing model/collection identity; this refactor requires no data migration.
  return connection.model('RecommendationTask', schema);
}
