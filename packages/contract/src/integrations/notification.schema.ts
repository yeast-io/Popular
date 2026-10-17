import { Type, type Static } from '@sinclair/typebox';
const channelId = Type.String({ minLength: 1, maxLength: 40, pattern: '^[a-z][a-z0-9_-]*$' });
export const SaveNotificationPreferencesSchema = Type.Object({
  enabled: Type.Boolean(), defaultChannel: channelId,
  additionalChannels: Type.Array(channelId, { maxItems: 10, uniqueItems: true }),
}, { additionalProperties: false });
export const NotificationPreferencesSchema = Type.Object({
  ...SaveNotificationPreferencesSchema.properties,
  channels: Type.Array(Type.Object({ id: channelId, name: Type.String(), configured: Type.Boolean() }, { additionalProperties: false })),
}, { additionalProperties: false });
export type SaveNotificationPreferences = Static<typeof SaveNotificationPreferencesSchema>;
export type NotificationPreferences = Static<typeof NotificationPreferencesSchema>;
