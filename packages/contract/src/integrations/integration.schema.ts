import { Static, Type } from '@sinclair/typebox';

export const MTEAM_DEFAULT_BASE_URL = 'https://api.m-team.cc';

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

export const MTeamConfigurationSchema = Type.Object({
  provider: Type.Literal('mteam'),
  status: IntegrationStatusSchema,
  baseUrl: Type.Optional(Type.String({ format: 'uri' })),
  lastValidationAt: Type.Optional(Type.String({ format: 'date-time' })),
  lastFailureType: Type.Optional(IntegrationFailureTypeSchema),
}, { additionalProperties: false });

export const SaveMTeamConfigurationRequestSchema = Type.Object({
  baseUrl: Type.String({ minLength: 1, maxLength: 2048 }),
  apiKey: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
}, { additionalProperties: false });

export type IntegrationStatus = Static<typeof IntegrationStatusSchema>;
export type IntegrationFailureType = Static<typeof IntegrationFailureTypeSchema>;
export type MTeamConfiguration = Static<typeof MTeamConfigurationSchema>;
export type SaveMTeamConfigurationRequest = Static<typeof SaveMTeamConfigurationRequestSchema>;
