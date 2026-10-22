import type { OpenAIAccountingOptions, RecordedTokenUsage, OpenAIRequestAttempt } from './request-accounting.types.js';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { ExternalRequestErrorCode } from '../../modules/external-usage/external-usage.types.js';
import type { LlmGenerateInput } from '../../modules/llm/llm.types.js';

/** Own retries at the SDK boundary so each physical request is recorded exactly once locally. */
export class OpenAIRequestAccounting {
  constructor(private readonly model: string, private readonly options?: OpenAIAccountingOptions) {}

  async request<T>(
    input: LlmGenerateInput,
    send: () => Promise<T>
  ): Promise<{ response: T; attempt: OpenAIRequestAttempt }> {
    const operationId = randomUUID();
    for (let index = 0; ; index++) {
      input.signal?.throwIfAborted();
      const started = Date.now();
      let recorded = false;
      const attempt: OpenAIRequestAttempt = {
        finish: async (outcome, usage, responseModel, error) => {
          if (recorded || !this.options) return;
          recorded = true;
          const status = (error as { status?: unknown } | undefined)?.status;
          const model = responseModel && /^[a-zA-Z0-9_.:/-]{1,128}$/.test(responseModel) ? responseModel : this.model;
          try {
            await this.options.recorder.record({
              actorType: 'user',
              ownerId: this.options.ownerId,
              provider: 'openai',
              operation: input.operation ?? 'conversation.reply',
              operationId,
              attempt: index + 1,
              trigger: index === 0 ? 'api_request' : 'retry',
              outcome,
              model,
              occurredAt: new Date(started),
              durationMs: Math.max(0, Date.now() - started),
              ...(usage ? { tokenUsage: usage } : {}),
              ...(typeof status === 'number' && status >= 100 && status <= 599 ? { httpStatus: status } : {}),
              ...(outcome === 'failure' ? { errorCode: classifyError(error) } : {}),
            }
            );
          } catch {
            /* Statistics failures must not retry a paid model request or break its response. */
          }
        },
      };
      try {
        return { response: await send(), attempt };
      } catch (error) {
        await attempt.finish('failure', undefined, undefined, error);
        if (input.signal?.aborted || index >= (this.options?.maxRetries ?? 0) || !retryable(error)) throw error;
        await delay(
          retryDelay(error, (this.options?.retryDelayMs ?? 250) * 2 ** index),
          undefined,
          input.signal ? { signal: input.signal } : undefined
        );
      }
    }
  }
}

/** Missing usage stays unknown; a reported zero is a valid measurement. */
export function readTokenUsage(value: unknown): RecordedTokenUsage | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const usage = value as {
    input_tokens?: unknown;
    output_tokens?: unknown;
    input_tokens_details?: { cached_tokens?: unknown };
  };
  const valid = (n: unknown): n is number => {
    return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
  };
  if (!valid(usage.input_tokens) || !valid(usage.output_tokens)) return undefined;
  const cached = usage.input_tokens_details?.cached_tokens;
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    ...(valid(cached) && cached <= usage.input_tokens ? { cachedInputTokens: cached } : {}),
  };
}

function retryable(error: unknown): boolean {
  const value = error as { status?: number; name?: string; code?: string } | null;
  if (value?.code === 'insufficient_quota') return false;
  return (
    [408, 409, 429].includes(value?.status ?? 0)
    || (value?.status ?? 0) >= 500
    || value?.name === 'APIConnectionError'
    || value?.name === 'APIConnectionTimeoutError'
  );
}

function retryDelay(error: unknown, fallback: number): number {
  const headers = (error as { headers?: Headers } | null)?.headers;
  if (!headers?.get) return fallback;
  const milliseconds = headers.get('retry-after-ms');
  const seconds = headers.get('retry-after');
  const value
    = milliseconds !== null
      ? Number(milliseconds)
      : seconds !== null
        ? Number.isFinite(Number(seconds))
          ? Number(seconds) * 1_000
          : Date.parse(seconds) - Date.now()
        : NaN;
  return Number.isFinite(value) && value >= 0 ? Math.min(value, 60_000) : fallback;
}

function classifyError(error: unknown): ExternalRequestErrorCode {
  const value = error as { status?: number; name?: string } | null;
  if (value?.status === 401) return 'authentication';
  if (value?.status === 403) return 'permission';
  if (value?.status === 429) return 'rate_limited';
  if (value?.status === 408 || value?.name === 'APIConnectionTimeoutError' || value?.name === 'TimeoutError')
    return 'timeout';
  if (value?.status) return 'remote_error';
  if (value?.name === 'LlmProviderError') return 'invalid_response';
  return 'network';
}
