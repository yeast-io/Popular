import { Schema, type Types, type InferSchemaType, type Connection } from 'mongoose';

const conversationSummarySchema = new Schema(
  {
    content: { type: String, required: true },
    throughSequence: { type: Number, min: 1, required: true },
    updatedAt: { type: Date, required: true },
  },
  { _id: false }
);

const conversationThreadSchema = new Schema(
  {
    ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    title: { type: String, required: false },
    status: {
      type: String,
      enum: {
        values: ['archived', 'active'],
      },
      required: true,
      default: 'active',
    },
    nextSequence: { type: Number, min: 1, required: true, default: 1 },
    lastMessageAt: { type: Date, required: false },
    summary: { type: conversationSummarySchema, required: false },
  },
  { timestamps: true, collection: 'conversation_threads' }
);

conversationThreadSchema.index({ ownerId: 1, updatedAt: -1 });
export type ConversationThreadDocument = InferSchemaType<typeof conversationThreadSchema> & { ownerId: Types.ObjectId };

export const createConversationThreadModel = (connection: Connection) => {
  return connection.model<ConversationThreadDocument>('ConversationThread', conversationThreadSchema);
};
