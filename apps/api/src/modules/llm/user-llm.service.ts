import type { AiProvider } from '@movie-hub/contract';
import type { LlmClient } from './llm.types.js';
import type { ResolvedUserLlm, UserLlmDependencies } from './llm-model.types.js';
import { AI_PROVIDERS, modelLimits } from '../integrations/ai-provider.policy.js';
import { AppError } from '../../infrastructure/http/app-error.js';
import { aiStep, currentAiTrace } from '../../infrastructure/logging/ai-trace.js';
import { aiSettingsMessages } from '../integrations/ai-settings.messages.js';

export class UserLlmService {
  constructor(private readonly dependencies: UserLlmDependencies) {}

  async resolve(ownerId: string): Promise<ResolvedUserLlm> {
    return aiStep('llm.selection.resolve', async () => {
      const selected = await this.dependencies.defaultProvider(ownerId);
      if (!AI_PROVIDERS.includes(selected as AiProvider))
        throw new AppError(403, 'AI_NOT_CONFIGURED', aiSettingsMessages.configure.en);
      const provider = selected as AiProvider;
      const { apiKey, model } = await this.dependencies.credentials(ownerId, provider);
      const limits = modelLimits(provider, model);
      if (!limits) throw new AppError(400, 'AI_MODEL_UNSUPPORTED', aiSettingsMessages.unsupported.en);
      currentAiTrace()?.sensitive(apiKey);
      currentAiTrace()?.event('llm.selection.resolved', { provider, model, contextWindow: limits.contextWindow });
      return { provider, model, apiKey, limits: { ...limits } };
    });
  }

  async create(ownerId: string): Promise<LlmClient> {
    const resolved = await this.resolve(ownerId);
    const adapter = this.dependencies.createClient(resolved, ownerId);
    // Provider maximum output is available to every operation, including structured decisions.
    const request = (input: Parameters<LlmClient['generate']>[0]) => ({ ...input, maxOutputTokens: resolved.limits.maxOutputTokens });
    return {
      limits: resolved.limits,
      selection: { provider: resolved.provider, model: resolved.model },
      generate: (input) => adapter.generate(request(input)),
      stream: (input) => adapter.stream(request(input)),
    };
  }
}
