import type { AiProvider } from '@movie-hub/contract';
import type { LlmModelLimits } from '../llm/llm-model.types.js';

export const AI_PROVIDERS = ['openai', 'deepseek', 'claude'] as const;
export const AI_PROVIDER_NAMES: Record<AiProvider, string> = { openai: 'OpenAI', deepseek: 'DeepSeek', claude: 'Claude' };
export const AI_PROVIDER_URLS: Record<AiProvider, string> = {
  openai: 'https://api.openai.com/v1', deepseek: 'https://api.deepseek.com', claude: 'https://api.anthropic.com/v1',
};
// Official model specifications, checked 2026-10-30. No application token allowance.
// https://developers.openai.com/api/docs/models
// https://api-docs.deepseek.com/quick_start/pricing/
// https://platform.claude.com/docs/en/models/overview
export const AI_MODEL_LIMITS: Record<AiProvider, Record<string, LlmModelLimits>> = {
  openai: Object.fromEntries([
    ...['gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4'].map((id) => [id, { contextWindow: 1_050_000, maxOutputTokens: 128_000 }]),
    ...['gpt-5.4-mini', 'gpt-5.4-nano', 'gpt-5.2', 'gpt-5.1', 'gpt-5', 'gpt-5-mini', 'gpt-5-nano'].map((id) => [id, { contextWindow: 400_000, maxOutputTokens: 128_000 }]),
  ]),
  deepseek: {
    'deepseek-flash': { contextWindow: 1_048_576, maxOutputTokens: 393_216 },
    'deepseek-v4-pro': { contextWindow: 1_048_576, maxOutputTokens: 393_216 },
  },
  claude: Object.fromEntries(['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'].map((id) => [id, { contextWindow: 1_000_000, maxOutputTokens: 128_000 }])),
};
export function modelLimits(provider: AiProvider, model: string): LlmModelLimits | undefined {
  const entries = AI_MODEL_LIMITS[provider];
  if (Object.hasOwn(entries, model)) return entries[model];
  // OpenAI dated snapshots share their documented base model limits.
  const base = model.replace(/-\d{4}-\d{2}-\d{2}$/, '');
  return Object.hasOwn(entries, base) ? entries[base] : undefined;
}
