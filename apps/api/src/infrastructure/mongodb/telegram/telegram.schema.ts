import { Schema, type Connection, type InferSchemaType } from 'mongoose';

const telegramBindingSchema = new Schema(
  {
    ownerId: { type: Schema.Types.ObjectId, required: true, ref: 'User' },
    chatId: String,
    account: String,
    pendingHash: { type: String, select: false },
    expiresAt: Date,
    lastTestAt: Date,
  },
  { timestamps: true, collection: 'telegram_bindings' },
);
telegramBindingSchema.index({ ownerId: 1 }, { unique: true });
telegramBindingSchema.index({ chatId: 1 }, { unique: true, partialFilterExpression: { chatId: { $type: 'string' } } });
telegramBindingSchema.index(
  { pendingHash: 1 },
  { unique: true, partialFilterExpression: { pendingHash: { $type: 'string' } } },
);
export const createTelegramModel = (connection: Connection) => {
  return connection.model('TelegramBinding', telegramBindingSchema);
};

export type TelegramBindingDocument = InferSchemaType<typeof telegramBindingSchema>;
