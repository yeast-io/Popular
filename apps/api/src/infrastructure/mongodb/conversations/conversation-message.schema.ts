import { Schema, type Connection, type Types, type InferSchemaType } from 'mongoose';

const conversationMessageSchema = new Schema(
  {
    ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    threadId: { type: Schema.Types.ObjectId, ref: 'ConversationThread', required: true },

    sequence: { type: Number, required: true, min: 1 },
    role: {
      type: String,
      enum: ['user', 'assistant', 'system'],
      required: true,
    },
    content: { type: String, required: true },
    clientRequestId: { type: String, required: false },
    inputTokens: { type: Number, required: false, min: 0 },
    outputTokens: { type: Number, required: false, min: 0 },
  },
  { timestamps: true, collection: 'conversation_messages' }
);

conversationMessageSchema.index({ threadId: 1, sequence: 1 }, { unique: true });
conversationMessageSchema.index({ ownerId: 1, threadId: 1, sequence: -1 });
conversationMessageSchema.index(
  { ownerId: 1, threadId: 1, role: 1, clientRequestId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      clientRequestId: { $type: 'string' },
    },
  }
);

export type ConversationMessageDocument = InferSchemaType<typeof conversationMessageSchema> & {
  ownerId: Types.ObjectId;
  threadId: Types.ObjectId;
};

export const createConversationMessageModel = (connection: Connection) => {
  return connection.model<ConversationMessageDocument>('ConversationMessage', conversationMessageSchema);
};
