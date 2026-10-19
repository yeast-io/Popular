import { Schema, type Connection } from 'mongoose';

const schema = new Schema(
  {
    ownerId: { type: Schema.Types.ObjectId, required: true, ref: 'User' },
    channel: { type: String, required: true, enum: ['telegram', 'whatsapp'] },
    chatId: { type: String, required: true },
    messageId: { type: String, required: true },
    text: { type: String, required: true },
    receivedAt: { type: Date, required: true },
    status: {
      type: String,
      required: true,
      enum: ['pending', 'processing', 'delivered', 'failed'],
      default: 'pending',
    },
    attempts: { type: Number, required: true, default: 0 },
    nextAttemptAt: { type: Date, required: true },
    leaseId: String,
    leaseUntil: Date,
    replyText: String,
    intent: String,
    movies: {
      type: [
        {
          tmdbId: { type: Number, required: true },
          title: { type: String, required: true },
          reason: { type: String, required: true },
          posterPath: String,
        },
      ],
      default: undefined,
      _id: false,
    },
    deliveredMovieCount: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true, collection: 'assistant_messages' },
);
schema.index({ ownerId: 1, channel: 1, chatId: 1, messageId: 1 }, { unique: true });
schema.index({ status: 1, nextAttemptAt: 1, receivedAt: 1 });
schema.index({ status: 1, receivedAt: 1, _id: 1 });
schema.index({ ownerId: 1, channel: 1, chatId: 1, status: 1, receivedAt: -1 });
export const createAssistantMessageModel = (connection: Connection) => {
  return connection.model('AssistantMessage', schema);
};
export type AssistantMessageModel = ReturnType<typeof createAssistantMessageModel>;
