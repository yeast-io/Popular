import { Type, type Static } from '@sinclair/typebox';

export const TelegramConfigurationSchema = Type.Object(
  {
    status: Type.Union([
      Type.Literal('unavailable'),
      Type.Literal('unbound'),
      Type.Literal('pending'),
      Type.Literal('connected'),
    ]),
    account: Type.Optional(Type.String()),
    expiresAt: Type.Optional(Type.String({ format: 'date-time' })),
  },
  { additionalProperties: false }
);
export const TelegramBindingSchema = Type.Object(
  {
    ...TelegramConfigurationSchema.properties,
    bindingUrl: Type.String({ format: 'uri' }),
  },
  { additionalProperties: false }
);
export const TelegramTestResultSchema = Type.Object({ messageId: Type.String() }, { additionalProperties: false });
export type TelegramConfiguration = Static<typeof TelegramConfigurationSchema>;
export type TelegramBinding = Static<typeof TelegramBindingSchema>;
