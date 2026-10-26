import { Schema, type Connection, type InferSchemaType } from 'mongoose';
import { RESOURCE_NOTIFICATION_LIMIT } from '../../../modules/resource-notifications/resource-notification.policy.js';

const entrySchema = new Schema(
  {
    id: { type: String, required: true },
    correlationId: { type: String, required: true },
    attempts: { type: Number, required: true, default: 0 },
    mediaType: { type: String, enum: ['movie', 'tv'], required: true },
    tmdbId: { type: Number, required: true, min: 1 },
    title: { type: String, required: true },
    status: { type: String, enum: ['pending', 'notified'], required: true },
    createdAt: { type: Date, required: true },
    nextRunAt: { type: Date, required: true },
    lockedUntil: { type: Date, required: true },
    leaseId: String,
    notifiedAt: Date,
    lastOutcome: { type: String, enum: ['no-channels', 'no-resources', 'failed', 'notified'] },
  },
  { _id: false }
);
export const resourceNotificationSchema = new Schema(
  {
    ownerId: { type: Schema.Types.ObjectId, required: true, ref: 'User' },
    entries: {
      type: [entrySchema],
      default: [],
      validate: (entries: unknown[]) => entries.length <= RESOURCE_NOTIFICATION_LIMIT,
    },
  },
  { collection: 'resource_notifications', timestamps: true }
);
resourceNotificationSchema.index({ ownerId: 1 }, { unique: true });
resourceNotificationSchema.index({ 'entries.status': 1, 'entries.nextRunAt': 1 });
export type ResourceNotificationDocument = InferSchemaType<typeof resourceNotificationSchema>;
export const createResourceNotificationModel = (connection: Connection) =>
  connection.model<ResourceNotificationDocument>('ResourceNotification', resourceNotificationSchema);
export type ResourceNotificationModel = ReturnType<typeof createResourceNotificationModel>;
