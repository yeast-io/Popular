import { Type, type Static } from '@sinclair/typebox';

export const AiProviderSchema = Type.Union((['openai', 'deepseek', 'claude'] as const).map((id) => Type.Literal(id)));
export type AiProvider = Static<typeof AiProviderSchema>;

export const AiValidationSchema = Type.Object(
  {
    status: Type.Union([Type.Literal('valid'), Type.Literal('failed')]),
    method: Type.Literal('model_list'),
    checkedAt: Type.String({ format: 'date-time' }),
    models: Type.Array(Type.String({ minLength: 1 })),
    failureReason: Type.Optional(
      Type.Union(
        (
          [
            'authentication',
            'quota',
            'rate_limit',
            'model',
            'timeout',
            'network',
            'invalid_response',
            'request_failed',
          ] as const
        ).map((value) => {
          return Type.Literal(value);
        })
      )
    ),
  },
  { additionalProperties: false }
);
export type AiValidation = Static<typeof AiValidationSchema>;

export const AiConfigurationSchema = Type.Object(
  {
    configured: Type.Boolean(),
    provider: Type.Optional(AiProviderSchema),
    maskedApiKey: Type.Optional(Type.String()),
    model: Type.Optional(Type.String()),
    validation: Type.Optional(AiValidationSchema),
  },
  { additionalProperties: false }
);
export const SaveAiConfigurationRequestSchema = Type.Object(
  {
    apiKey: Type.String({ minLength: 20, maxLength: 4096, pattern: '^\\S+$' }),
  },
  { additionalProperties: false }
);
export type AiConfiguration = Static<typeof AiConfigurationSchema>;
export type SaveAiConfigurationRequest = Static<typeof SaveAiConfigurationRequestSchema>;

export const SelectAiModelRequestSchema = Type.Object(
  {
    model: Type.String({ minLength: 1, maxLength: 256 }),
  },
  { additionalProperties: false }
);
export type SelectAiModelRequest = Static<typeof SelectAiModelRequestSchema>;
