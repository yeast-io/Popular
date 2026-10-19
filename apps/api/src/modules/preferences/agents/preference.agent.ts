import { aiStep, currentAiTrace } from '../../../infrastructure/logging/ai-trace.js';
import { z } from 'zod';
import type { TasteProfile } from '@movie-hub/contract';
import type { LlmClient } from '../../llm/llm.types.js';
import type { PreferenceJob, PreferenceProposal } from '../preference.types.js';
import { PREFERENCE_PROMPT_VERSION, PREFERENCE_SYSTEM_PROMPT } from '../../../config/system-prompts/preference.prompts.js';
import { buildLlmContext } from '../../llm/llm.context.js';
import { ProposalSchema } from '../preference-proposal.schema.js';

export class PreferenceAgent {
  constructor(
    private readonly createLlm: (ownerId: string) => Promise<Pick<LlmClient, 'generate'>>,
    private readonly maxContextTokens = 32_000
  ) {}
  async run(job: PreferenceJob, profile: TasteProfile, signal: AbortSignal): Promise<PreferenceProposal> {
    const llm = await aiStep('preference.credentials.load', () => this.createLlm(job.ownerId));
    const maxOutputTokens = Math.min(2500, Math.floor(this.maxContextTokens / 3));
    const payload = JSON.stringify({
      mode: job.kind,
      promptVersion: PREFERENCE_PROMPT_VERSION,
      profile: { version: profile.version, entries: profile.entries, withdrawn: profile.withdrawn },
      evidence: job.evidence,
    });
    currentAiTrace()?.sensitive(payload);
    currentAiTrace()?.sensitive(PREFERENCE_SYSTEM_PROMPT);
    const messages = await aiStep('preference.context.build', async () => {
      return buildLlmContext(PREFERENCE_SYSTEM_PROMPT, payload, [], this.maxContextTokens, maxOutputTokens);
    });
    const result = await aiStep('preference.model.generate', () => {
      return llm.generate({
        messages,
        maxOutputTokens,
        operation: 'preference.update',
        signal,
        outputSchema: { name: 'preference_update', schema: z.toJSONSchema(ProposalSchema) },
      }
      );
    });
    currentAiTrace()?.sensitive(result.content);
    return aiStep('preference.proposal.parse', async () => {
      let proposal: unknown;
      try {
        proposal = JSON.parse(result.content);
      } catch {
        throw new SyntaxError('Preference model returned invalid JSON');
      }
      return ProposalSchema.parse(proposal);
    });
  }
}
