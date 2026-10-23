import { Type, type Static } from '@sinclair/typebox';

export const RemoteClientDeviceSchema = Type.Object({
  id: Type.String(), authVersion: Type.Integer({ minimum: 1 }), deviceVersion: Type.Integer({ minimum: 1 }),
  boundAt: Type.String({ format: 'date-time' }),
  isAgentOnline: Type.Boolean(), isAgentDownloaderOnline: Type.Boolean(),
  downloaderInstanceId: Type.Optional(Type.String()),
  statusCheckedAt: Type.Optional(Type.String({ format: 'date-time' })),
  downloaderType: Type.Optional(Type.Union([Type.Literal('qbittorrent'), Type.Literal('transmission')])),
}, { additionalProperties: false });
export const RemoteClientConfigurationSchema = Type.Object({
  hasKey: Type.Boolean(), canReadKey: Type.Boolean(), authVersion: Type.Integer({ minimum: 0 }),
  deviceLimit: Type.Integer({ minimum: 1 }), devices: Type.Array(RemoteClientDeviceSchema),
  gatewayNotificationPending: Type.Boolean(),
}, { additionalProperties: false });
export const RemoteClientMutationSchema = Type.Object({
  operationId: Type.String({ format: 'uuid' }), expectedAuthVersion: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER - 1 }),
}, { additionalProperties: false });
export const RemoteClientUnbindSchema = Type.Object({
  ...RemoteClientMutationSchema.properties, expectedDeviceVersion: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER - 1 }),
}, { additionalProperties: false });
export const RemoteClientDeviceParamsSchema = Type.Object({ deviceId: Type.String({ minLength: 1, maxLength: 160, pattern: '^[a-zA-Z0-9_-]+$' }) }, { additionalProperties: false });
export const RemoteClientKeySchema = Type.Object({ apiKey: Type.String(), authVersion: Type.Integer({ minimum: 1 }) }, { additionalProperties: false });
export const RemoteClientMutationResultSchema = Type.Object({
  configuration: RemoteClientConfigurationSchema, apiKey: Type.Union([Type.String(), Type.Null()]),
}, { additionalProperties: false });
/** Breaking Gateway contract: device events revoke only one device; key events revoke older key generations. */
export const RemoteAuthorizationChangeSchema = Type.Union([
  Type.Object({ scope: Type.Literal('key'), eventId: Type.String(), ownerId: Type.String(), authVersion: Type.Integer({ minimum: 1 }), correlationId: Type.String() }, { additionalProperties: false }),
  Type.Object({ scope: Type.Literal('device'), eventId: Type.String(), ownerId: Type.String(), authVersion: Type.Integer({ minimum: 1 }), deviceId: Type.String(), deviceVersion: Type.Integer({ minimum: 1 }), correlationId: Type.String() }, { additionalProperties: false }),
]);
export type RemoteClientDevice = Static<typeof RemoteClientDeviceSchema>;
export type RemoteClientConfiguration = Static<typeof RemoteClientConfigurationSchema>;
export type RemoteClientMutation = Static<typeof RemoteClientMutationSchema>;
export type RemoteClientUnbind = Static<typeof RemoteClientUnbindSchema>;
export type RemoteClientDeviceParams = Static<typeof RemoteClientDeviceParamsSchema>;
export type RemoteClientKey = Static<typeof RemoteClientKeySchema>;
export type RemoteClientMutationResult = Static<typeof RemoteClientMutationResultSchema>;
export type RemoteAuthorizationChange = Static<typeof RemoteAuthorizationChangeSchema>;
