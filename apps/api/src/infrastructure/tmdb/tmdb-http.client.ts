import { randomUUID } from 'node:crypto';
import { aiStep, currentAiTrace } from '../logging/ai-trace.js';
import type { ExternalRequestContext, ExternalRequestErrorCode, ExternalRequestRecorder } from '../../modules/external-usage/external-usage.types.js';

export class TmdbHttpError extends Error {
  constructor(readonly status: number) {
    super(`TMDB request failed with status ${status}`);
  }
}
export class TmdbHttpClient {
  constructor(
    private readonly credential: string,
    private readonly timeoutMs: number,
    private readonly fetcher: typeof fetch = globalThis.fetch,
    private readonly usage?: ExternalRequestRecorder
  ) {}

  async request(url: URL, operation: string, context?: ExternalRequestContext): Promise<Response> {
    currentAiTrace()?.sensitive(this.credential);
    const isV3ApiKey = /^[0-9a-f]{32}$/i.test(this.credential);
    if (isV3ApiKey)
      url.searchParams.set('api_key', this.credential);
    const operationId = randomUUID();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const startedAt = Date.now();
      let response: Response;
      try {
        response = await aiStep('external.tmdb.request', () => {
          return this.fetcher(url, {
            headers: {
              accept: 'application/json',
              ...(isV3ApiKey ? {} : { authorization: `Bearer ${this.credential}` }),
            },
            signal: AbortSignal.timeout(this.timeoutMs),
            redirect: 'error',
          });
        }, { provider: 'tmdb', operation, operationId, attempt: attempt + 1 });
      } catch (error) {
        await this.record(context, {
          operation,
          operationId,
          attempt: attempt + 1,
          outcome: 'failure',
          errorCode: isTimeoutError(error) ? 'timeout' : 'network',
          durationMs: Date.now() - startedAt,
        });
        throw error;
      }
      await this.record(context, {
        operation,
        operationId,
        attempt: attempt + 1,
        outcome: response.ok ? 'success' : 'failure',
        ...(response.ok ? {} : { errorCode: tmdbHttpErrorCode(response.status) }),
        httpStatus: response.status,
        durationMs: Date.now() - startedAt,
      });
      currentAiTrace()?.event('external.tmdb.response', {
        provider: 'tmdb',
        operation,
        operationId,
        attempt: attempt + 1,
        httpStatus: response.status,
        durationMs: Date.now() - startedAt,
        outcome: response.ok ? 'success' : 'failure',
      });
      if (response.ok)
        return response;
      if (response.status !== 429 || attempt === 2)
        throw new TmdbHttpError(response.status);
      const retryAfter = Number(response.headers.get('retry-after'));
      const delayMs = Number.isFinite(retryAfter) && retryAfter >= 0
        ? retryAfter * 1000
        : 250 * 2 ** attempt + Math.floor(Math.random() * 150);
      currentAiTrace()?.event('external.tmdb.retry', {
        provider: 'tmdb',
        operation,
        operationId,
        attempt: attempt + 1,
        delayMs,
      });
      await new Promise((resolve) => setTimeout(resolve, Math.min(delayMs, this.timeoutMs)));
    }
    throw new Error('TMDB retry loop ended unexpectedly');
  }

  private async record(context: ExternalRequestContext | undefined, event: {
    operation: string;
    operationId: string;
    attempt: number;
    outcome: 'success' | 'failure';
    durationMs: number;
    httpStatus?: number;
    errorCode?: ExternalRequestErrorCode;
  }): Promise<void> {
    if (!context || !this.usage)
      return;
    try {
      await this.usage.record({
        ...context,
        ...event,
        trigger: event.attempt > 1 ? 'retry' : context.trigger,
        provider: 'tmdb',
        occurredAt: new Date(),
      });
    } catch {
      // Usage telemetry must never change the upstream request result.
    }
  }
}
function tmdbHttpErrorCode(status: number): ExternalRequestErrorCode {
  if (status === 401)
    return 'authentication';
  if (status === 403)
    return 'permission';
  if (status === 429)
    return 'rate_limited';
  return 'remote_error';
}
function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
}
