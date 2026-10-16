import { Type, type Static } from '@sinclair/typebox';

export const OpenAIConfigurationSchema = Type.Object({
  configured: Type.Boolean(),
  maskedApiKey: Type.Optional(Type.String()),
}, { additionalProperties: false });
export const SaveOpenAIConfigurationRequestSchema = Type.Object({
  apiKey: Type.String({ minLength: 20, maxLength: 4096, pattern: '^\\S+$' }),
}, { additionalProperties: false });
export type OpenAIConfiguration = Static<typeof OpenAIConfigurationSchema>;
export type SaveOpenAIConfigurationRequest = Static<typeof SaveOpenAIConfigurationRequestSchema>;
