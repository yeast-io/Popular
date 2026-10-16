export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmGenerateInput {
  messages: LlmMessage[];
  maxOutputTokens: number;
  signal?: AbortSignal;
}

export interface LlmGenerateResult {
  content: string;
  inputTokens: number;
  outputTokens: number;
}

export type LlmStreamEvent =
  | { type: 'delta'; delta: string }
  | { type: 'completed'; inputTokens: number; outputTokens: number };

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

export class LlmProviderError extends Error {
  constructor(message: string, options?: ErrorOptions, public readonly diagnostics?: LlmFailureDiagnostics) {
    super(message, options);
    this.name = 'LlmProviderError';
  }
}
