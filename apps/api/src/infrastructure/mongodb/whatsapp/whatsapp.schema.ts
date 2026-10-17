import { Schema, type Connection, type InferSchemaType } from 'mongoose';

const whatsappSessionSchema = new Schema({
  ownerId: { type: Schema.Types.ObjectId, required: true, ref: 'User' },
  encryptedState: { type: String, select: false },
  leaseId: String,
  leaseUntil: Date,
}, { timestamps: true, collection: 'whatsapp_sessions' });
whatsappSessionSchema.index({ ownerId: 1 }, { unique: true });
export const createWhatsAppModel = (connection: Connection) => connection.model('WhatsAppSession', whatsappSessionSchema);

export type WhatsAppSessionDocument = InferSchemaType<typeof whatsappSessionSchema>;
