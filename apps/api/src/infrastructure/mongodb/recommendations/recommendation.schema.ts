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
    { timestamps: true, collection: 'recommendation_tasks' }
  );
  schema.index({ ownerId: 1, conversation: 1 }, { unique: true });
  return connection.model('RecommendationTask', schema);
}
