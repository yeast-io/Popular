import { z } from 'zod';
import { ASSISTANT_INTENT_SYSTEM_PROMPT, buildAssistantDiscussionPrompt } from '../../../config/system-prompts/assistant.prompts.js';
import type { LlmClient, LlmMessage } from '../../llm/llm.types.js';
import { buildLlmContext } from '../../llm/llm.context.js';
import type { AssistantAgentOptions, AssistantInputWorkflowMessage, AssistantIntent, AssistantWorkflowResult } from '../assistant.types.js';
import { currentAiTrace } from '../../../infrastructure/logging/ai-trace.js';

const IntentResultSchema = z.strictObject({
  intent: z.enum(['discuss', 'recommend', 'resources', 'download', 'unclear']),
  preferenceSignal: z.enum(['none', 'explicit', 'uncertain']).default('none'),
});
const OUTPUT_TOKEN_LIMIT = 256;

/** Model-only intent detection and discussion. Business routing belongs to AssistantWorkflow. */
export class AssistantAgent {
  constructor(
    private readonly llm: Pick<LlmClient, 'generate'>,
    private readonly options: AssistantAgentOptions
  ) {}

  async detectIntent(
    input: AssistantInputWorkflowMessage,
    history: LlmMessage[] = [],
    signal?: AbortSignal,
  ): Promise<{ intent: AssistantIntent; preferenceSignal: 'none' | 'explicit' | 'uncertain' }> {
    signal?.throwIfAborted();
    const result = await this.llm.generate({
      messages: buildLlmContext(ASSISTANT_INTENT_SYSTEM_PROMPT, input.text, history,
        this.options.maxContextTokens, OUTPUT_TOKEN_LIMIT),
      maxOutputTokens: OUTPUT_TOKEN_LIMIT,
      operation: 'assistant.intent',
      ...(signal ? { signal } : {}),
      outputSchema: { name: 'assistant_intent', schema: {
        type: 'object',
        properties: { intent: { type: 'string', enum: IntentResultSchema.shape.intent.options },
          preferenceSignal: { type: 'string', enum: ['none', 'explicit', 'uncertain'] } },
        required: ['intent', 'preferenceSignal'], additionalProperties: false,
      } },
    });
    signal?.throwIfAborted();
    // Provider failures, malformed JSON, and invalid values must not masquerade as unclear intent.
    currentAiTrace()?.sensitive(result.content);
    return IntentResultSchema.parse(JSON.parse(result.content));
  }

  async discuss(input: AssistantInputWorkflowMessage, history: LlmMessage[] = [], signal?: AbortSignal): Promise<AssistantWorkflowResult> {
    signal?.throwIfAborted();
    const result = await this.llm.generate({
      messages: buildLlmContext(buildAssistantDiscussionPrompt(this.options.systemPrompt), input.text,
        history, this.options.maxContextTokens, this.options.maxOutputTokens),
      maxOutputTokens: this.options.maxOutputTokens,
      operation: 'assistant.discuss',
      ...(signal ? { signal } : {}),
    });
    signal?.throwIfAborted();
    if (!result.content.trim()) throw new Error('Assistant returned an empty reply');
    return { intent: 'discuss', replyText: result.content.trim() };
  }
}
