import { AppError } from '../http/app-error.js';
import { LlmProviderError } from '../../modules/llm/llm.errors.js';
import { aiSettingsMessages } from '../../modules/integrations/ai-settings.messages.js';

export function rethrowLlmError(error: unknown): never {
  const status = (error as { status?: number } | null)?.status;
  if (status === 401 || status === 403)
    throw new AppError(502, 'AI_AUTH_FAILED', aiSettingsMessages.authentication.en, undefined, { cause: error });
  if (status === 402)
    throw new AppError(502, 'AI_QUOTA_EXCEEDED', aiSettingsMessages.quota.en, undefined, { cause: error });
  if (status === 429)
    throw new AppError(503, 'AI_RATE_LIMITED', aiSettingsMessages.rateLimit.en, undefined, { cause: error });
  if (error instanceof LlmProviderError) throw error;
  throw new LlmProviderError('AI provider request failed', { cause: error });
}
