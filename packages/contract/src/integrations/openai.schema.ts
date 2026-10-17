import { Type, type Static } from '@sinclair/typebox';

export const OpenAIValidationSchema = Type.Object({
  status: Type.Union([Type.Literal('valid'), Type.Literal('failed')]),
  method: Type.Literal('model_lookup'),
  checkedAt: Type.String({ format: 'date-time' }), model: Type.String(),
  failureReason: Type.Optional(Type.Union((['authentication', 'quota', 'rate_limit', 'model', 'timeout', 'network', 'invalid_response', 'request_failed'] as const).map(value => Type.Literal(value)))),
}, { additionalProperties: false });
export type OpenAIValidation = Static<typeof OpenAIValidationSchema>;

export const OpenAIConfigurationSchema = Type.Object({
  configured: Type.Boolean(),
  maskedApiKey: Type.Optional(Type.String()),
  model: Type.Optional(Type.String()),
  validation: Type.Optional(OpenAIValidationSchema),
}, { additionalProperties: false });
export const SaveOpenAIConfigurationRequestSchema = Type.Object({
  apiKey: Type.String({ minLength: 20, maxLength: 4096, pattern: '^\\S+$' }),
}, { additionalProperties: false });
export type OpenAIConfiguration = Static<typeof OpenAIConfigurationSchema>;
export type SaveOpenAIConfigurationRequest = Static<typeof SaveOpenAIConfigurationRequestSchema>;
