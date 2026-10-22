import { Static, Type } from '@sinclair/typebox';

export const PublicConfigSchema = Type.Object({
  notificationTestEnabled: Type.Boolean(),
  aiAssistantEnabled: Type.Boolean(),
  avatar: Type.Object({
    maxBytes: Type.Integer({ minimum: 1 }),
    maxPixels: Type.Integer({ minimum: 1 }),
  }),
});

export type PublicConfig = Static<typeof PublicConfigSchema>;
