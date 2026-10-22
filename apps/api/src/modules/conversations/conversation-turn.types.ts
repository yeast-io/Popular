import type { LlmClient, LlmStreamEvent, LlmGenerateResult, LlmMessage } from '../llm/llm.types.js';
import type { ConversationMessage } from './conversation.types.js';

export interface ConversationTurnOptions {
  systemPrompt: string;
  maxContextTokens: number;
  maxOutputTokens: number;
  summaryMaxOutputTokens: number;
  historyLimit?: number;
  safetyMarginTokens?: number;
  messageOverheadTokens?: number;
  reply?: (
    input: RunConversationTurnInput,
    messages: LlmMessage[],
    llm: LlmClient,
    streaming?: boolean
  ) => Promise<LlmGenerateResult & { stream?: AsyncIterable<LlmStreamEvent> }>;
  profileContext?: (ownerId: string) => Promise<string>;
}

export interface RunConversationTurnInput {
  ownerId: string;
  threadId: string;
  content: string;
  clientRequestId: string;
  signal?: AbortSignal;
}

export type ConversationTurnStreamEvent
  = | { type: 'user_message'; message: ConversationMessage }
    | { type: 'delta'; delta: string }
    | { type: 'completed'; assistantMessage: ConversationMessage; usage: ConversationTurnResult['usage'] };

export interface ConversationTurnResult {
  userMessage: ConversationMessage;
  assistantMessage: ConversationMessage;
  usage: Pick<LlmGenerateResult, 'inputTokens' | 'outputTokens'>;
}
