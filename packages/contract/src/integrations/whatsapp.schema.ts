import { Type, type Static } from '@sinclair/typebox';

export const WhatsAppConfigurationSchema = Type.Object(
  {
    status: Type.Union(
      (['unbound', 'connecting', 'qr', 'pairing', 'connected', 'disconnected', 'error'] as const).map((s) => {
        return Type.Literal(s);
      }),
    ),
    failureReason: Type.Optional(
      Type.Union(
        (
          [
            'logged_out',
            'bad_session',
            'connection_replaced',
            'forbidden',
            'timeout',
            'connection_lost',
            'connection_error',
            'storage_error',
            'lease_lost',
          ] as const
        ).map((s) => {
          return Type.Literal(s);
        }),
      ),
    ),
    disconnectCode: Type.Optional(Type.Integer({ minimum: 0, maximum: 9999 })),
    account: Type.Optional(Type.String()),
    qrDataUrl: Type.Optional(Type.String()),
    qrExpiresAt: Type.Optional(Type.String({ format: 'date-time' })),
  },
  { additionalProperties: false },
);
export type WhatsAppConfiguration = Static<typeof WhatsAppConfigurationSchema>;
export const WhatsAppTestResultSchema = Type.Object({ messageId: Type.String() }, { additionalProperties: false });
