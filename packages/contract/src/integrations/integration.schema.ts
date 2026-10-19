import { Static, Type } from '@sinclair/typebox';

export const MTEAM_DEFAULT_BASE_URL = 'https://api.m-team.cc';
export const MTEAM_DEFAULT_WEB_BASE_URL = 'https://kp.m-team.cc';

export const IntegrationStatusSchema = Type.Union([
  Type.Literal('unconfigured'),
  Type.Literal('configured_valid'),
  Type.Literal('configured_invalid'),
  Type.Literal('configured_unverified'),
]);

export const IntegrationFailureTypeSchema = Type.Union([
  Type.Literal('authentication'),
  Type.Literal('network'),
  Type.Literal('timeout'),
  Type.Literal('invalid_response'),
  Type.Literal('remote_error'),
]);

export const MTeamConfigurationSchema = Type.Object(
  {
    provider: Type.Literal('mteam'),
    status: IntegrationStatusSchema,
    baseUrl: Type.Optional(Type.String({ format: 'uri' })),
    webBaseUrl: Type.Optional(Type.String({ format: 'uri' })),
    lastValidationAt: Type.Optional(Type.String({ format: 'date-time' })),
    lastFailureType: Type.Optional(IntegrationFailureTypeSchema),
  },
  { additionalProperties: false },
);

export const SaveMTeamConfigurationRequestSchema = Type.Object(
  {
    baseUrl: Type.String({ minLength: 1, maxLength: 2048 }),
    webBaseUrl: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
    apiKey: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
  },
  { additionalProperties: false },
);

export const QBittorrentAuthMethodSchema = Type.Union([Type.Literal('api_key'), Type.Literal('username_password')]);

export const QBittorrentConfigurationSchema = Type.Object(
  {
    provider: Type.Literal('qbittorrent'),
    status: IntegrationStatusSchema,
    baseUrl: Type.Optional(Type.String({ format: 'uri' })),
    authMethod: Type.Optional(QBittorrentAuthMethodSchema),
    username: Type.Optional(Type.String()),
    version: Type.Optional(Type.String()),
    lastValidationAt: Type.Optional(Type.String({ format: 'date-time' })),
    lastFailureType: Type.Optional(IntegrationFailureTypeSchema),
  },
  { additionalProperties: false },
);

const QBittorrentBaseUrlSchema = Type.String({ minLength: 1, maxLength: 2048 });

export const SaveQBittorrentConfigurationRequestSchema = Type.Union([
  Type.Object(
    {
      baseUrl: QBittorrentBaseUrlSchema,
      authMethod: Type.Literal('api_key'),
      apiKey: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      baseUrl: QBittorrentBaseUrlSchema,
      authMethod: Type.Literal('username_password'),
      username: Type.String({ minLength: 1, maxLength: 256 }),
      password: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
    },
    { additionalProperties: false },
  ),
]);

export type IntegrationStatus = Static<typeof IntegrationStatusSchema>;
export type IntegrationFailureType = Static<typeof IntegrationFailureTypeSchema>;
export type MTeamConfiguration = Static<typeof MTeamConfigurationSchema>;
export type SaveMTeamConfigurationRequest = Static<typeof SaveMTeamConfigurationRequestSchema>;
export type QBittorrentAuthMethod = Static<typeof QBittorrentAuthMethodSchema>;
export type QBittorrentConfiguration = Static<typeof QBittorrentConfigurationSchema>;
export type SaveQBittorrentConfigurationRequest = Static<typeof SaveQBittorrentConfigurationRequestSchema>;

export const TransmissionConfigurationSchema = Type.Object(
  {
    provider: Type.Literal('transmission'),
    status: IntegrationStatusSchema,
    baseUrl: Type.Optional(Type.String({ format: 'uri' })),
    username: Type.Optional(Type.String()),
    version: Type.Optional(Type.String()),
    lastValidationAt: Type.Optional(Type.String({ format: 'date-time' })),
    lastFailureType: Type.Optional(IntegrationFailureTypeSchema),
  },
  { additionalProperties: false },
);

export const SaveTransmissionConfigurationRequestSchema = Type.Object(
  {
    baseUrl: Type.String({ minLength: 1, maxLength: 2048 }),
    username: Type.String({ minLength: 1, maxLength: 256 }),
    password: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
  },
  { additionalProperties: false },
);

export type TransmissionConfiguration = Static<typeof TransmissionConfigurationSchema>;
export type SaveTransmissionConfigurationRequest = Static<typeof SaveTransmissionConfigurationRequestSchema>;
