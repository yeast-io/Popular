import type { LlmClient, LlmGenerateInput, LlmGenerateResult, LlmStreamEvent } from '../../modules/llm/llm.types.js';
import type { ProviderHttpOptions } from '../llm/provider-http.types.js';
import type { LlmAccountingOptions, LlmRequestAttempt, RecordedTokenUsage } from '../llm/llm-request-accounting.types.js';
import { ProviderHttpClient, ProviderHttpError, readProviderEvents } from '../llm/provider-http.client.js';
import { LlmRequestAccounting } from '../llm/llm-request-accounting.adapter.js';
import { rethrowLlmError } from '../llm/llm-provider.errors.js';
import { LlmProviderError } from '../../modules/llm/llm.errors.js';
import { currentAiTrace } from '../logging/ai-trace.js';
import { parseLlmJson } from '../../modules/llm/llm-output.schema.js';

export class ClaudeLlmAdapter implements LlmClient {
  private readonly http: ProviderHttpClient;
  private readonly accounting: LlmRequestAccounting;

  constructor(private readonly model: string, options: ProviderHttpOptions, accounting?: LlmAccountingOptions) {
    this.http = new ProviderHttpClient(options);
    this.accounting = new LlmRequestAccounting(model, accounting ? { ...accounting, provider: 'claude' } : undefined);
  }

  async generate(input: LlmGenerateInput): Promise<LlmGenerateResult> {
    let content = '';
    let usage: LlmGenerateResult | undefined;
    // Always use transport streaming: Claude requires it for large max_tokens requests.
    for await (const event of this.stream(input)) {
      if (event.type === 'delta') content += event.delta;
      else usage = { content, inputTokens: event.inputTokens, outputTokens: event.outputTokens };
    }
    if (!usage) throw new LlmProviderError('Claude response did not complete');
    return usage;
  }

  async* stream(input: LlmGenerateInput): AsyncIterable<LlmStreamEvent> {
    const started = Date.now();
    let attempt: LlmRequestAttempt | undefined;
    let usage: RecordedTokenUsage | undefined;
    let responseModel: string | undefined;
    let content = '';
    let stopped = false;
    let stopReason: unknown;
    let failure: unknown;
    let outcome: 'success' | 'failure' = 'failure';
    currentAiTrace()?.event('llm.request.started', { provider: 'claude', model: this.model, operation: input.operation, streaming: true });
    try {
      const tracked = await this.accounting.request(input, () => this.http.request('/messages', {
        model: this.model, max_tokens: input.maxOutputTokens, stream: true,
        system: input.messages.filter((message) => message.role === 'system').map((message) => message.content).join('\n\n'),
        messages: input.messages.filter((message) => message.role !== 'system').map((message) => ({ role: message.role, content: message.content })),
        ...(input.outputSchema ? { output_config: { format: { type: 'json_schema', schema: input.outputSchema.schema } } } : {}),
      }, input.signal));
      attempt = tracked.attempt;
      for await (const event of readProviderEvents(tracked.response)) {
        input.signal?.throwIfAborted();
        if (event.type === 'error') {
          const type = (event.error as { type?: string } | undefined)?.type;
          throw new ProviderHttpError(type === 'overloaded_error' ? 529 : type === 'rate_limit_error' ? 429 : 502);
        }
        if (event.type === 'message_start') {
          const message = event.message as { model?: string; usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } } | undefined;
          responseModel = message?.model;
          const value = message?.usage;
          if (value && valid(value.input_tokens) && valid(value.output_tokens)) {
            usage = { inputTokens: value.input_tokens + (value.cache_read_input_tokens ?? 0) + (value.cache_creation_input_tokens ?? 0), outputTokens: value.output_tokens,
              cachedInputTokens: value.cache_read_input_tokens ?? 0 };
          }
        }
        if (event.type === 'content_block_delta') {
          const delta = event.delta as { type?: string; text?: string } | undefined;
          if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
            content += delta.text;
            currentAiTrace()?.sensitive(delta.text);
            yield { type: 'delta', delta: delta.text };
          }
        }
        if (event.type === 'message_delta') {
          stopReason = (event.delta as { stop_reason?: unknown } | undefined)?.stop_reason;
          const tokens = (event.usage as { output_tokens?: unknown } | undefined)?.output_tokens;
          if (usage && valid(tokens)) usage.outputTokens = tokens;
          else usage = undefined;
        }
        if (event.type === 'message_stop') {
          stopped = true;
          break;
        }
      }
      if (stopReason === 'refusal') throw new LlmProviderError('Claude refused structured output', undefined, {
        reason: 'refusal', provider: 'claude', model: this.model,
        ...(input.operation ? { operation: input.operation } : {}),
      });
      if (!stopped || !content.trim() || !usage || !['end_turn', 'stop_sequence'].includes(String(stopReason)))
        throw new LlmProviderError('Claude stream was incomplete, refused, or missing usage');
      if (input.outputSchema) parseLlmJson(content, {
        reason: 'invalid_json', provider: 'claude', model: this.model,
        ...(input.operation ? { operation: input.operation } : {}), schemaName: input.outputSchema.name,
      });
      outcome = 'success';
      yield { type: 'completed', inputTokens: usage.inputTokens, outputTokens: usage.outputTokens };
    } catch (error) {
      failure = error;
      currentAiTrace()?.fail(error, {
        ...(error instanceof LlmProviderError ? error.diagnostics : {}),
        stage: 'claude.stream', durationMs: Date.now() - started,
      });
      if (input.signal?.aborted) throw error;
      rethrowLlmError(error);
    } finally {
      currentAiTrace()?.sensitive(content);
      await attempt?.finish(outcome, usage, responseModel, failure);
      currentAiTrace()?.event('llm.request.completed', { provider: 'claude', model: this.model, outcome, durationMs: Date.now() - started });
    }
  }
}
function valid(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
