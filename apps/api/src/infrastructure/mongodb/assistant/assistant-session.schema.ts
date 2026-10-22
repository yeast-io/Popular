import { Schema, type Connection } from 'mongoose';

export function createAssistantSessionModel(connection: Connection) {
  const schema = new Schema(
    {
      ownerId: { type: String, required: true },
      conversation: { type: String, required: true },
      data: { type: Schema.Types.Mixed, required: true },
      leaseId: String,
      leaseUntil: Date,
      expiresAt: Date,
    },
    { timestamps: true, collection: 'assistant_workflow_sessions' }
  );
  schema.index({ ownerId: 1, conversation: 1 }, { unique: true });
  schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  return connection.model('AssistantWorkflowSession', schema);
}
