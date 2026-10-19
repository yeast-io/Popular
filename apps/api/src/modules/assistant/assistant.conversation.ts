import { aiStep } from '../../infrastructure/logging/ai-trace.js';
import type { ConversationTurnOptions } from '../conversations/conversation-turn.types.js';
import type { AssistantWorkflowOptions } from './assistant.types.js';
import { AssistantWorkflow } from './assistant.workflow.js';

/** Adapt the shared assistant to conversation storage/SSE without a second discussion implementation. */
export function createAssistantConversationReply(
  options: AssistantWorkflowOptions,
): NonNullable<ConversationTurnOptions['reply']> {
  return async (input, messages, llm, streaming) => {
    let inputTokens = 0,
      outputTokens = 0;
    const tracked = {
      stream: llm.stream.bind(llm),
      generate: async (request: Parameters<typeof llm.generate>[0]) => {
        const result = await llm.generate(request);
        inputTokens += result.inputTokens;
        outputTokens += result.outputTokens;
        return result;
      },
    };
    // The conversation service already incorporated its saved summary in this system message.
    const workflow = new AssistantWorkflow(async () => tracked, {
      ...options,
      systemPrompt: messages.find((message) => message.role === 'system')?.content ?? options.systemPrompt,
    });
    const result = await aiStep('assistant.workflow.run', () => {
      return workflow.run(
        {
          ownerId: input.ownerId,
          channel: 'web',
          chatId: input.threadId,
          messageId: input.clientRequestId,
          text: input.content,
          receivedAt: new Date().toISOString(),
        },
        messages.slice(0, -1),
        input.signal,
        streaming,
      );
    });
    return {
      content: result.replyText,
      inputTokens,
      outputTokens,
      ...(result.stream ? { stream: result.stream } : {}),
    };
  };
}
