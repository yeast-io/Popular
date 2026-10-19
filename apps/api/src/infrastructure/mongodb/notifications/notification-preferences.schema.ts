import { Schema, type Connection, type InferSchemaType } from 'mongoose';

const notificationPreferencesSchema = new Schema(
  {
    ownerId: { type: Schema.Types.ObjectId, required: true, ref: 'User' },
    enabled: { type: Boolean, default: false },
    defaultChannel: { type: String, default: 'whatsapp' },
    additionalChannels: { type: [String], default: [] },
    epoch: { type: Number, default: 0 },
  },
  { timestamps: true, collection: 'notification_preferences' },
);
notificationPreferencesSchema.index({ ownerId: 1 }, { unique: true });
export const createNotificationPreferencesModel = (connection: Connection) => {
  return connection.model('NotificationPreferences', notificationPreferencesSchema);
};

export type NotificationPreferencesDocument = InferSchemaType<typeof notificationPreferencesSchema>;
