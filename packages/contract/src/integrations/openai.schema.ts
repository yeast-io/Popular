// Compatibility exports for existing OpenAI integrations.
export {
  AiValidationSchema as OpenAIValidationSchema,
  AiConfigurationSchema as OpenAIConfigurationSchema,
  SaveAiConfigurationRequestSchema as SaveOpenAIConfigurationRequestSchema,
  SelectAiModelRequestSchema as SelectOpenAIModelRequestSchema,
} from './ai.schema.js';
export type {
  AiValidation as OpenAIValidation,
  AiConfiguration as OpenAIConfiguration,
  SaveAiConfigurationRequest as SaveOpenAIConfigurationRequest,
  SelectAiModelRequest as SelectOpenAIModelRequest,
} from './ai.schema.js';
