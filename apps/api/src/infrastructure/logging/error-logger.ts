import type { Logger } from 'pino';

const loggedErrors = new WeakSet<object>();

export interface ErrorContext {
  operation: string;
  requestId?: string;
}

export function logErrorOnce(logger: Logger, error: unknown, context: ErrorContext): Error {
  const normalized = normalizeError(error);
  if (!loggedErrors.has(normalized)) {
    logger.error(
      {
        err: normalized,
        operation: context.operation,
        ...(context.requestId ? { requestId: context.requestId } : {}),
      },
      'Operation failed',
    );
    loggedErrors.add(normalized);
  }
  return normalized;
}

function normalizeError(error: unknown): Error {
  if (error instanceof Error) return error;
  return new Error(typeof error === 'string' ? error : 'Unknown non-Error value thrown', { cause: error });
}
