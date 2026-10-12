import type { FastifyInstance } from 'fastify';
import { AppError } from './app-error.js';
import { logErrorOnce } from '../logging/error-logger.js';
import type { AppLoggers } from '../logging/logger.js';

export function registerErrorHandler(app: FastifyInstance, loggers: AppLoggers): void {
  app.setErrorHandler((error, request, reply) => {
    logErrorOnce(loggers.error, error, { operation: 'http.request', requestId: request.id });

    if (error instanceof AppError) {
      return reply.status(error.statusCode).send({
        error: { code: error.code, message: error.message, requestId: request.id, ...(error.details === undefined ? {} : { details: error.details }) },
      });
    }

    if (typeof error === 'object' && error !== null && 'validation' in error && error.validation) {
      return reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: 'Request validation failed', requestId: request.id, details: error.validation },
      });
    }

    if (hasErrorCode(error, 'FST_ERR_CTP_BODY_TOO_LARGE')) {
      return reply.status(413).send({
        error: { code: 'BAD_REQUEST', message: 'Request body is too large', requestId: request.id },
      });
    }

    if (hasErrorCode(error, 'FST_ERR_CTP_INVALID_MEDIA_TYPE')) {
      return reply.status(415).send({
        error: { code: 'BAD_REQUEST', message: 'Unsupported media type', requestId: request.id },
      });
    }

    return reply.status(500).send({
      error: { code: 'INTERNAL_ERROR', message: 'An internal error occurred', requestId: request.id },
    });
  });
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}
