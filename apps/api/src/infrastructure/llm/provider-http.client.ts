import type { ProviderHttpOptions, ProviderStreamEvent } from './provider-http.types.js';
import { AI_PROVIDER_URLS } from '../../modules/integrations/ai-provider.policy.js';
import { currentAiTrace } from '../logging/ai-trace.js';
import { LlmProviderError } from '../../modules/llm/llm.errors.js';

export class ProviderHttpError extends Error {
  constructor(readonly status: number, readonly code?: string, options?: ErrorOptions) {
    super(`AI provider HTTP request failed (${status})`, options);
    this.name = 'ProviderHttpError';
  }
}

export class ProviderHttpClient {
  constructor(private readonly options: ProviderHttpOptions) {}

  async request(path: string, body?: unknown, signal?: AbortSignal): Promise<Response> {
    currentAiTrace()?.sensitive(this.options.apiKey);
    const started = Date.now();
    currentAiTrace()?.event('llm.http.started', { provider: this.options.provider, stage: path });
    try {
      const response = await (this.options.fetch ?? fetch)(`${AI_PROVIDER_URLS[this.options.provider]}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.options.provider === 'claude'
            ? {
                'x-api-key': this.options.apiKey, 'anthropic-version': '2023-06-01',
              }
            : { authorization: `Bearer ${this.options.apiKey}` }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(this.options.timeoutMs)]) : AbortSignal.timeout(this.options.timeoutMs),
      });
      currentAiTrace()?.event('llm.http.completed', {
        provider: this.options.provider, stage: path, status: response.status,
        durationMs: Date.now() - started, outcome: response.ok ? 'success' : 'failure',
      });
      if (!response.ok) {
        // Do not retain upstream payloads: gateways can echo credentials or conversation content.
        await response.body?.cancel();
        throw new ProviderHttpError(response.status);
      }
      return response;
    } catch (error) {
      currentAiTrace()?.fail(error, { stage: 'llm.http', durationMs: Date.now() - started });
      throw error;
    }
  }
}

/** Decode UTF-8 incrementally, including CRLF and split frames; release/cancel on early exit. */
export async function* readProviderEvents(response: Response): AsyncIterable<ProviderStreamEvent> {
  if (!response.body) throw new LlmProviderError('AI stream has no response body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let done = false;
  try {
    while (!done) {
      const chunk = await reader.read();
      done = chunk.done;
      buffer += decoder.decode(chunk.value, { stream: !done });
      let separator: RegExpExecArray | null;
      while ((separator = /\r?\n\r?\n/.exec(buffer))) {
        const frame = buffer.slice(0, separator.index);
        buffer = buffer.slice(separator.index + separator[0].length);
        const data = frame.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
        if (!data || data === '[DONE]') continue;
        try {
          const event: unknown = JSON.parse(data);
          if (!event || typeof event !== 'object' || !('type' in event) || typeof event.type !== 'string')
            throw new LlmProviderError('AI stream event is invalid');
          yield event as ProviderStreamEvent;
        } catch (error) {
          if (error instanceof LlmProviderError) throw error;
          // JSON parse errors may embed response text; keep them out of diagnostics.
          throw new LlmProviderError('AI stream returned invalid JSON');
        }
      }
    }
    if (buffer.trim()) throw new LlmProviderError('AI stream ended with an incomplete frame');
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
