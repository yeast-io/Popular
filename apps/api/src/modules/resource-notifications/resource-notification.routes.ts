import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  ApiErrorSchema,
  ResourceNotificationListSchema,
  ResourceNotificationMembershipSchema,
  TvLocaleQuerySchema,
  WatchlistItemParamsSchema,
} from '@movie-hub/contract';
import type { TvLocaleQuery, WatchlistItemParams } from '@movie-hub/contract';
import type { AppConfig } from '../../config/env.schema.js';
import { AiTrace, aiStep, withAiTrace } from '../../infrastructure/logging/ai-trace.js';
import type { AiLogger } from '../../infrastructure/logging/ai-trace.types.js';
import type { AuthService } from '../auth/auth.service.js';
import { readSessionToken } from '../auth/auth.routes.js';
import type { ResourceNotificationService } from './resource-notification.service.js';

export function registerResourceNotificationRoutes(
  app: FastifyInstance,
  service: ResourceNotificationService,
  auth: AuthService,
  config: AppConfig,
  logger: AiLogger
) {
  async function run<T>(request: FastifyRequest, operation: string, action: (ownerId: string) => Promise<T>) {
    const trace = new AiTrace(
      logger,
      { requestId: request.id, correlationId: request.id },
      '',
      'resource-notification.api',
      config.VERBOSE
    );
    return withAiTrace(trace, async () => {
      try {
        return await aiStep(operation, async () =>
          action(await auth.requireOwnerId(readSessionToken(request, config.SESSION_COOKIE_NAME)))
        );
      } catch (error) {
        trace.fail(error);
        throw error;
      }
    });
  }
  app.get<{ Querystring: TvLocaleQuery }>(
    '/me/resource-notifications',
    {
      schema: {
        querystring: TvLocaleQuerySchema,
        response: { 200: ResourceNotificationListSchema, 401: ApiErrorSchema },
      },
    },
    (request) =>
      run(request, 'resource-notification.list', (ownerId) =>
        service.list(ownerId, request.query.locale ?? config.TMDB_LANGUAGE)
      )
  );
  app.get<{ Params: WatchlistItemParams }>(
    '/me/resource-notifications/:mediaType/:tmdbId',
    {
      schema: {
        params: WatchlistItemParamsSchema,
        response: { 200: ResourceNotificationMembershipSchema, 401: ApiErrorSchema },
      },
    },
    (request) =>
      run(request, 'resource-notification.membership', (ownerId) =>
        service.membership(ownerId, request.params.mediaType, request.params.tmdbId)
      )
  );
  app.put<{ Params: WatchlistItemParams; Querystring: TvLocaleQuery }>(
    '/me/resource-notifications/:mediaType/:tmdbId',
    {
      schema: {
        params: WatchlistItemParamsSchema,
        querystring: TvLocaleQuerySchema,
        response: {
          200: ResourceNotificationMembershipSchema,
          401: ApiErrorSchema,
          404: ApiErrorSchema,
          409: ApiErrorSchema,
        },
      },
    },
    (request) =>
      run(request, 'resource-notification.add', (ownerId) =>
        service.add(
          ownerId,
          request.params.mediaType,
          request.params.tmdbId,
          request.query.locale ?? config.TMDB_LANGUAGE
        )
      )
  );
  app.delete<{ Params: WatchlistItemParams }>(
    '/me/resource-notifications/:mediaType/:tmdbId',
    {
      schema: {
        params: WatchlistItemParamsSchema,
        response: { 200: ResourceNotificationMembershipSchema, 401: ApiErrorSchema },
      },
    },
    (request) =>
      run(request, 'resource-notification.remove', (ownerId) =>
        service.remove(ownerId, request.params.mediaType, request.params.tmdbId)
      )
  );
}
