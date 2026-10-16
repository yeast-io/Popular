import { currentAiTrace } from '../logging/ai-trace.js';
import { AppError } from '../http/app-error.js';
import type OpenAI from 'openai';
import type { LlmClient, LlmGenerateInput, LlmGenerateResult, LlmStreamEvent, LlmFailureDiagnostics } from '../../modules/llm/llm.types.js';
import { LlmProviderError } from '../../modules/llm/llm.types.js';

export class OpenAILlmClient implements LlmClient {
  constructor(
    private readonly client: Pick<OpenAI, 'responses'>,
    private readonly model: string,
  ) {}

  async generate(input: LlmGenerateInput): Promise<LlmGenerateResult> {
    currentAiTrace()?.event('openai.request.started', { model: this.model, maxOutputTokens: input.maxOutputTokens, streaming: false });
    try {
      const response = await this.client.responses.create({
        model: this.model,
        input: input.messages.map(({ role, content }) => ({ role, content })),
        max_output_tokens: input.maxOutputTokens,
        store: false,
      }, input.signal ? { signal: input.signal } : undefined);
      if (!response.output_text.trim()) {
        throw new LlmProviderError('OpenAI returned no output text');
      }
      if (!response.usage) {
        throw new LlmProviderError('OpenAI returned no token usage');
      }
      return {
        content: response.output_text,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      };
    } catch (error) {
      if (error instanceof AppError || error instanceof LlmProviderError) throw error;
      const upstream = error as { status?: number; code?: string } | null;
      if (upstream?.status === 401 || upstream?.status === 403) {
        throw new AppError(502, 'OPENAI_AUTH_FAILED', 'OpenAI API key is invalid or lacks permission', undefined, { cause: error });
      }
      if (upstream?.status === 429) {
        throw new AppError(429, upstream.code === 'insufficient_quota' ? 'OPENAI_QUOTA_EXCEEDED' : 'OPENAI_RATE_LIMITED', 'OpenAI quota or rate limit reached', undefined, { cause: error });
      }
      throw new LlmProviderError('OpenAI response generation failed', { cause: error });
    }
  }

  async *stream(input: LlmGenerateInput): AsyncIterable<LlmStreamEvent> {
    currentAiTrace()?.event('openai.request.started', { model: this.model, maxOutputTokens: input.maxOutputTokens, streaming: true });
    const diagnostics: LlmFailureDiagnostics = { reason: 'upstream_exception', receivedText: false };
    try {
      const stream = await this.client.responses.create({
        model: this.model,
        input: input.messages.map(({ role, content }) => ({ role, content })),
        max_output_tokens: input.maxOutputTokens,
        store: false,
        stream: true,
      }, input.signal ? { signal: input.signal } : undefined);
      let completed = false;

      for await (const event of stream) {
        // Copy only known metadata. Never retain raw events, text, or provider messages.
        diagnostics.lastEventType = safeEventType(event.type);
        if ('response' in event) {
          diagnostics.responseId = safeIdentifier(event.response.id, 'resp_');
        }
        if (event.type === 'response.output_text.delta' || event.type === 'response.refusal.delta') {
          if (event.delta) diagnostics.receivedText = true;
          if (event.delta) yield { type: 'delta', delta: event.delta };
          continue;
        }
        if (event.type === 'response.completed') {
          const usage = event.response.usage;
          if (!usage) throw new LlmProviderError('OpenAI returned no token usage', undefined, { ...diagnostics, reason: 'missing_usage' });
          currentAiTrace()?.event('openai.response.completed', { responseId: diagnostics.responseId, inputTokens: usage.input_tokens, outputTokens: usage.output_tokens });
          completed = true;
          yield {
            type: 'completed',
            inputTokens: usage.input_tokens,
            outputTokens: usage.output_tokens,
          };
          continue;
        }
        if (event.type === 'error' || event.type === 'response.failed' || event.type === 'response.incomplete') {
          if (event.type === 'response.incomplete') {
            diagnostics.incompleteReason = safeCode(event.response.incomplete_details?.reason);
          }
          diagnostics.upstreamCode = safeCode(event.type === 'error' ? event.code : event.response.error?.code);
          const upstream = event.type === 'error' ? event : event.response.error;
          const cause = upstream ? Object.assign(new Error(upstream.message), { code: upstream.code }) : undefined;
          throw new LlmProviderError('OpenAI streaming response failed', cause ? { cause } : undefined, { ...diagnostics, reason: 'terminal_failure' });
        }
      }

      if (!completed) throw new LlmProviderError('OpenAI stream ended before completion', undefined, { ...diagnostics, reason: 'missing_completion' });
    } catch (error) {
      if (error instanceof AppError || error instanceof LlmProviderError) throw error;
      const upstream = error as { status?: number; code?: string } | null;
      if (upstream?.status === 401 || upstream?.status === 403) {
        throw new AppError(502, 'OPENAI_AUTH_FAILED', 'OpenAI API key is invalid or lacks permission', undefined, { cause: error });
      }
      if (upstream?.status === 429) {
        throw new AppError(429, upstream.code === 'insufficient_quota' ? 'OPENAI_QUOTA_EXCEEDED' : 'OPENAI_RATE_LIMITED', 'OpenAI quota or rate limit reached', undefined, { cause: error });
      }
      const metadata = error as { status?: unknown; code?: unknown; request_id?: unknown } | null;
      if (typeof metadata?.status === 'number' && Number.isInteger(metadata.status) && metadata.status >= 100 && metadata.status <= 599) {
        diagnostics.upstreamStatus = metadata.status;
      }
      diagnostics.upstreamCode = safeCode(metadata?.code);
      diagnostics.upstreamRequestId = safeIdentifier(metadata?.request_id, 'req_');
      throw new LlmProviderError('OpenAI response streaming failed', { cause: error }, diagnostics);
    }
  }
}

function safeCode(value: unknown): string | undefined {
  const allowed = new Set([
    'max_output_tokens', 'content_filter', 'server_error', 'rate_limit_exceeded',
    'insufficient_quota', 'invalid_api_key', 'invalid_request_error',
    'invalid_prompt', 'vector_store_timeout', 'permission_denied',
  ]);
  return typeof value === 'string' && allowed.has(value) ? value : undefined;
}

function safeIdentifier(value: unknown, prefix: string): string | undefined {
  return typeof value === 'string' && value.startsWith(prefix) && /^[a-zA-Z0-9_-]{5,160}$/.test(value)
    ? value : undefined;
}

function safeEventType(value: string): string {
  const allowed = new Set([
    'response.created', 'response.in_progress', 'response.output_text.delta',
    'response.output_text.done', 'response.output_item.added', 'response.output_item.done',
    'response.content_part.added', 'response.content_part.done', 'response.refusal.delta',
    'response.refusal.done', 'response.completed', 'response.failed', 'response.incomplete', 'error',
  ]);
  return allowed.has(value) ? value : 'other';
}
