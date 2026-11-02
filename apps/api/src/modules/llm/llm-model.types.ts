import type { AiProvider } from '@movie-hub/contract';
import type { LlmClient } from './llm.types.js';

export interface LlmModelSelection { provider: AiProvider; model: string }
export interface LlmModelLimits { contextWindow: number; maxOutputTokens: number }
export interface ResolvedUserLlm { provider: AiProvider; model: string; apiKey: string; limits: LlmModelLimits }
export interface UserLlmDependencies {
  defaultProvider(ownerId: string): Promise<string | undefined>;
  credentials(ownerId: string, provider: AiProvider): Promise<{ apiKey: string; model: string }>;
  createClient(resolved: ResolvedUserLlm, ownerId: string): LlmClient;
}
