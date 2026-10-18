import { z } from 'zod';
import { ASSISTANT_INTENT_SYSTEM_PROMPT, buildAssistantDiscussionPrompt } from '../../../config/system-prompts.js';
import type { LlmClient, LlmMessage } from '../../llm/llm.types.js';
import { buildAssistantContext } from '../assistant.context.js';
import type { AssistantInputWorkflowMessage, AssistantIntent, AssistantWorkflowResult } from '../assistant.type.js';
import { aiStep, currentAiTrace } from '../../../infrastructure/logging/ai-trace.js';

const IntentResultSchema = z.strictObject({
  intent: z.enum(['discuss', 'recommend', 'resources', 'download', 'unclear']),
});
const OUTPUT_TOKEN_LIMIT = 256;

export interface AssistantAgentOptions {
  systemPrompt: string;
  maxContextTokens: number;
  maxOutputTokens: number;
}

/** One personal assistant owns intent understanding and the four capability handlers. */
export class AssistantAgent {
  constructor(
    private readonly llm: Pick<LlmClient, 'generate'>,
    private readonly options: AssistantAgentOptions,
  )
  {
  }

  /** Public entry point: understand the message, then handle the selected capability. */
  async run(
    input: AssistantInputWorkflowMessage,
    history: LlmMessage[] = [],
    signal?: AbortSignal,
  ): Promise<AssistantWorkflowResult> {
    const { intent } = await aiStep('assistant.intent.detect', () => this.detectIntent(input, history, signal));
    currentAiTrace()?.event('assistant.intent.selected', { intent });
    return aiStep('assistant.intent.handle', () => this.handleIntent(input, intent, history, signal));
  }

  private async detectIntent(
    input: AssistantInputWorkflowMessage,
    history: LlmMessage[] = [],
    signal?: AbortSignal,
  ): Promise<{ intent: AssistantIntent }> {
    signal?.throwIfAborted();
    const result = await this.llm.generate({
      messages: buildAssistantContext(ASSISTANT_INTENT_SYSTEM_PROMPT, input.text, history,
        this.options.maxContextTokens, OUTPUT_TOKEN_LIMIT),
      maxOutputTokens: OUTPUT_TOKEN_LIMIT,
      operation: 'assistant.intent',
      ...(signal ? { signal } : {}),
      outputSchema: { name: 'assistant_intent', schema: {
        type: 'object',
        properties: { intent: { type: 'string', enum: IntentResultSchema.shape.intent.options } },
        required: ['intent'], additionalProperties: false,
      } },
    });
    signal?.throwIfAborted();
    // Provider failures, malformed JSON, and invalid values must not masquerade as unclear intent.
    currentAiTrace()?.sensitive(result.content);
    return IntentResultSchema.parse(JSON.parse(result.content));
  }

  /** Handle the selected capability; workflow code owns execution state and delivery coordination. */
  private async handleIntent(
    input: AssistantInputWorkflowMessage,
    intent: AssistantIntent,
    history: LlmMessage[] = [],
    signal?: AbortSignal,
  ): Promise<AssistantWorkflowResult> {
    signal?.throwIfAborted();
    if (intent === 'discuss') {
      const result = await this.llm.generate({
        messages: buildAssistantContext(buildAssistantDiscussionPrompt(this.options.systemPrompt), input.text,
          history, this.options.maxContextTokens, this.options.maxOutputTokens),
        maxOutputTokens: this.options.maxOutputTokens,
        operation: 'assistant.discuss',
        ...(signal ? { signal } : {}),
      });
      signal?.throwIfAborted();
      if (!result.content.trim()) throw new Error('Assistant returned an empty reply');
      return { intent, replyText: result.content.trim() };
    }

    // Replace each placeholder with its business tool/workflow integration when that capability is implemented.
    const replies: Record<Exclude<AssistantIntent, 'discuss'>, string> = {
      recommend: '已识别为电影推荐请求。个性化推荐尚未接通，目前可以继续讨论电影或其他话题。',
      resources: '已识别为电影资源查询请求。资源查询尚未接通，我目前无法查看真实资源或判断是否可下载。',
      download: '已识别为下载相关请求。远程下载尚未接通，本次没有创建、修改或取消任何下载任务。',
      unclear: '你希望我聊聊这个话题、推荐电影、查电影资源，还是处理下载？请补充一下具体需求。',
    };
    return { intent, replyText: replies[intent] };
  }
}
