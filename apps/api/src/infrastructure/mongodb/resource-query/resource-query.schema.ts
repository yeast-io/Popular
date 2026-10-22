import { Schema, type Connection } from 'mongoose';

export function createResourceQueryModel(connection: Connection) {
  const schema = new Schema(
    {
      ownerId: { type: String, required: true },
      conversation: { type: String, required: true },
      data: { type: Schema.Types.Mixed, required: true },
      leaseId: String,
      leaseUntil: Date,
      expiresAt: Date,
    },
    { timestamps: true }
  );
  schema.index({ ownerId: 1, conversation: 1 }, { unique: true });
  schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  return connection.model('AssistantResourceQuery', schema);
}
