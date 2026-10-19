export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmGenerateInput {
  messages: LlmMessage[];
  maxOutputTokens: number;
  signal?: AbortSignal;
  /** Optional strict JSON response schema for non-streaming classification. */
  outputSchema?: { name: string; schema: Record<string, unknown> };
  /** Attribution for request statistics; not included in the provider payload. */
  operation?:
    | 'conversation.reply'
    | 'conversation.summary'
    | 'assistant.intent'
    | 'assistant.discuss'
    | 'preference.update'
    | 'assistant.recommend'
    | 'assistant.resources.plan'
    | 'assistant.download.plan';
}

export interface LlmGenerateResult {
  content: string;
  inputTokens: number;
  outputTokens: number;
}

export type LlmStreamEvent =
  { type: 'delta'; delta: string } | { type: 'completed'; inputTokens: number; outputTokens: number };

export interface LlmClient {
  generate(input: LlmGenerateInput): Promise<LlmGenerateResult>;
  stream(input: LlmGenerateInput): AsyncIterable<LlmStreamEvent>;
}

export interface LlmFailureDiagnostics {
  reason: 'missing_usage' | 'missing_completion' | 'terminal_failure' | 'upstream_exception';
  lastEventType?: string | undefined;
  responseId?: string | undefined;
  upstreamRequestId?: string | undefined;
  upstreamStatus?: number;
  upstreamCode?: string | undefined;
  incompleteReason?: string | undefined;
  receivedText?: boolean;
}
