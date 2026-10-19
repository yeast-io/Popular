import { Type, type Static } from '@sinclair/typebox';
import { NotificationPreferencesSchema } from './notification.schema.js';
import { DownloadProviderSchema } from '../downloads/movie-download.schema.js';
export const NotificationTestListSchema = Type.Object({
  channels: NotificationPreferencesSchema.properties.channels,
  items: Type.Array(
    Type.Object({
      id: Type.String(),
      tmdbId: Type.Integer(),
      title: Type.String(),
      resourceName: Type.String(),
      provider: DownloadProviderSchema,
      totalBytes: Type.Number(),
      posterUrl: Type.Optional(Type.String()),
      lastSyncedAt: Type.Optional(Type.String()),
    }),
  ),
  page: Type.Integer(),
  hasMore: Type.Boolean(),
});
export const NotificationTestResultSchema = Type.Object({
  results: Type.Array(Type.Object({ channel: Type.String(), sent: Type.Boolean() })),
});
export type NotificationTestList = Static<typeof NotificationTestListSchema>;
export type NotificationTestResult = Static<typeof NotificationTestResultSchema>;

export const SendNotificationTestSchema = Type.Object(
  {
    channel: Type.String({ minLength: 1, maxLength: 40, pattern: '^[a-z][a-z0-9_-]*$' }),
  },
  { additionalProperties: false },
);
export type SendNotificationTest = Static<typeof SendNotificationTestSchema>;
