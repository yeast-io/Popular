import {
  ApiErrorSchema,
  ExternalUsageQuerySchema,
  ExternalUsageResponseSchema,
  type ExternalUsageQuery,
} from '@movie-hub/contract';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppConfig } from '../../config/env.schema.js';
import { readSessionToken } from '../auth/auth.routes.js';
import type { ExternalUsageService } from './external-usage.service.js';

export function registerExternalUsageRoutes(
  app: FastifyInstance,
  service: ExternalUsageService,
  config: AppConfig
): void {
  app.get<{ Querystring: ExternalUsageQuery }>(
    '/me/external-usage',
    {
      schema: {
        querystring: ExternalUsageQuerySchema,
        response: { 200: ExternalUsageResponseSchema, 401: ApiErrorSchema },
      },
    },
    async (request) => service.readMine(token(request, config), request.query.days ?? 30)
  );
}

function token(request: FastifyRequest, config: AppConfig): string | undefined {
  return readSessionToken(request, config.SESSION_COOKIE_NAME);
}
