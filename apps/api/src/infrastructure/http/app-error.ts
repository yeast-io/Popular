import type { ErrorCode } from '@movie-hub/contract';

export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: unknown,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = 'AppError';
  }
}
