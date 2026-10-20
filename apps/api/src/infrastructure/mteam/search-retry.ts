import type { SearchRetryOptions } from './search-retry.types.js';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { currentAiTrace } from '../logging/ai-trace.js';
import { IntegrationValidationError } from '../../modules/integrations/integration.service.js';

/** Only transport-level evidence makes a remote_error retryable; business rejections are terminal. */
export class MTeamHttpError extends IntegrationValidationError {
  constructor(
    failureType: IntegrationValidationError['failureType'],
    public readonly statusCode: number,
    public readonly retryAfterMs?: number
  ) {
    super(failureType, `M-Team returned HTTP ${statusCode}`);
    this.name = 'MTeamHttpError';
  }
}
export function parseRetryAfter(value: string | undefined, now = Date.now()): number | undefined {
  if (!value) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(value.trim())) return Number(value) * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}
export function isRetryableSearchError(error: unknown): boolean {
  if (!(error instanceof IntegrationValidationError)) return false;
  if (error.failureType === 'timeout' || error.failureType === 'rate_limited') return true;
  if (error instanceof MTeamHttpError) return [500, 502, 503, 504].includes(error.statusCode);
  if (error.failureType !== 'network') return false;
  // Rejecting an unsafe/private address is not a transient connectivity failure.
  const cause = error.cause as { code?: string } | undefined;
  return Boolean(cause?.code && [
    'EAI_AGAIN', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED',
    'ENETUNREACH', 'EHOSTUNREACH', 'EPIPE', 'ERR_STREAM_PREMATURE_CLOSE',
  ].includes(cause.code));
}
/** A single logical read: at most three attempts, including waits, within a 40-second budget. */
export async function retryMTeamSearch<T>(
  operation: (attempt: number, operationId: string, signal: AbortSignal, remainingMs: number) => Promise<T>,
  options: SearchRetryOptions = {},
): Promise<T> {
  const now = options.now ?? Date.now;
  const wait = options.wait ?? ((milliseconds, signal) => delay(milliseconds, undefined, { signal }));
  const started = now();
  const budgetMs = options.budgetMs ?? 40_000;
  const operationId = randomUUID();
  const controller = new AbortController();
  const executionSignal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
  let lastError: unknown;
  const timer = setTimeout(() => {
    return controller.abort(new IntegrationValidationError(
      'timeout', 'M-Team resource query exceeded its total time budget', lastError ? { cause: lastError } : undefined,
    )
    );
  }, budgetMs);
  const trace = currentAiTrace();
  try {
    executionSignal.throwIfAborted();
    for (let attempt = 1; attempt <= 3; attempt++) {
      const remainingMs = budgetMs - (now() - started);
      if (remainingMs <= 0) throw lastError ?? new IntegrationValidationError('timeout', 'M-Team resource query exceeded its total time budget');
      const attemptStarted = now();
      trace?.event('external.mteam.search.attempt.started', { provider: 'mteam', operationId, attempt, remainingMs });
      try {
        const result = await abortable(() => {
          return operation(attempt, operationId, executionSignal, remainingMs);
        }, executionSignal);
        trace?.event('external.mteam.search.attempt.completed', { provider: 'mteam', operationId, attempt, durationMs: now() - attemptStarted, outcome: 'success' });
        return result;
      } catch (error) {
        lastError = error;
        const retryable = isRetryableSearchError(error);
        trace?.fail(error, { stage: 'external.mteam.search.attempt', provider: 'mteam', operationId, attempt, durationMs: now() - attemptStarted, retryable, outcome: 'failure' });
        if (executionSignal.aborted || !retryable || attempt === 3) throw error;
        const backoff = Math.max(1000, options.minimumIntervalMs ?? 0) * 2 ** (attempt - 1);
        const jitter = Math.floor((options.random ?? Math.random)() * 250);
        const retryAfter = error instanceof MTeamHttpError ? error.retryAfterMs ?? 0 : 0;
        const waitMs = Math.max(backoff + jitter, retryAfter);
        // Never retry earlier than Retry-After merely to fit the budget.
        if (waitMs >= budgetMs - (now() - started)) throw error;
        trace?.clearFailure();
        trace?.event('external.mteam.search.retry.scheduled', { provider: 'mteam', operationId, attempt, nextAttempt: attempt + 1, waitMs });
        try {
          await abortable(() => wait(waitMs, executionSignal), executionSignal);
        } catch (waitError) {
          throw executionSignal.aborted ? executionSignal.reason : waitError;
        }
      }
    }
    throw lastError;
  } finally {
    clearTimeout(timer);
  }
}
async function abortable<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort!: () => void;
  const interrupted = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    return await Promise.race([operation(), interrupted]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}
