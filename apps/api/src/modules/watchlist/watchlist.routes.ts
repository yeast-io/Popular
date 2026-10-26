import type { FastifyInstance, FastifyRequest } from 'fastify';
import { WatchlistItemParamsSchema, WatchlistResourceNotificationSchema, ApiErrorSchema, TvShowParamsSchema, TvLocaleQuerySchema, WatchlistQuerySchema, WatchlistResponseSchema, WatchlistMembershipSchema } from '@movie-hub/contract';
import type { WatchlistItemParams, WatchlistResourceNotification, TvShowParams, TvLocaleQuery, WatchlistQuery } from '@movie-hub/contract';
import type { AppConfig } from '../../config/env.schema.js';
import { AiTrace, aiStep, withAiTrace } from '../../infrastructure/logging/ai-trace.js';
import type { AiLogger } from '../../infrastructure/logging/ai-trace.types.js';
import type { AuthService } from '../auth/auth.service.js';
import { readSessionToken } from '../auth/auth.routes.js';
import type { WatchlistService } from './watchlist.service.js';

export function registerWatchlistRoutes(app: FastifyInstance, service: WatchlistService, auth: AuthService, config: AppConfig, logger: AiLogger): void {
  async function run<T>(request: FastifyRequest, operation: string, action: (ownerId: string) => Promise<T>) {
    const trace = new AiTrace(logger, { requestId: request.id, correlationId: request.id }, '', 'watchlist.api', config.VERBOSE);
    return withAiTrace(trace, async () => {
      try {
        return await aiStep(operation, async () => action(await auth.requireOwnerId(readSessionToken(request, config.SESSION_COOKIE_NAME))));
      } catch (error) {
        trace.fail(error);
        throw error;
      }
    });
  }
  app.get<{ Querystring: WatchlistQuery }>('/me/watchlist', {
    schema: { querystring: WatchlistQuerySchema, response: { 200: WatchlistResponseSchema, 401: ApiErrorSchema } },
  }, (request) => run(request, 'watchlist.list', (ownerId) => service.list(ownerId, request.query.mediaType, request.query.page ?? 1, request.query.pageSize ?? 20, request.query.locale ?? config.TMDB_LANGUAGE)));
  app.delete<{ Params: WatchlistItemParams }>('/me/watchlist/:mediaType/:tmdbId', {
    schema: { params: WatchlistItemParamsSchema, response: { 200: WatchlistMembershipSchema, 401: ApiErrorSchema } },
  }, (request) => run(request, 'watchlist.remove', (ownerId) => service.remove(ownerId, request.params.mediaType, request.params.tmdbId)));
  app.put<{ Params: WatchlistItemParams; Body: WatchlistResourceNotification; Querystring: TvLocaleQuery }>('/me/watchlist/:mediaType/:tmdbId/resource-notification', {
    schema: { params: WatchlistItemParamsSchema, body: WatchlistResourceNotificationSchema, querystring: TvLocaleQuerySchema, response: { 200: WatchlistResourceNotificationSchema, 401: ApiErrorSchema, 404: ApiErrorSchema } },
  }, (request) => run(request, 'watchlist.resource-notification', (ownerId) => service.setResourceNotification(ownerId, request.params.mediaType, request.params.tmdbId, request.body.enabled, request.query.locale ?? config.TMDB_LANGUAGE)));
  app.get<{ Params: TvShowParams }>('/me/watchlist/tv-shows/:tmdbId', {
    schema: { params: TvShowParamsSchema, response: { 200: WatchlistMembershipSchema, 401: ApiErrorSchema } },
  }, (request) => run(request, 'watchlist.membership', (ownerId) => service.membership(ownerId, request.params.tmdbId)));
  app.put<{ Params: TvShowParams; Querystring: TvLocaleQuery }>('/me/watchlist/tv-shows/:tmdbId', {
    schema: { params: TvShowParamsSchema, querystring: TvLocaleQuerySchema, response: { 200: WatchlistMembershipSchema, 401: ApiErrorSchema, 404: ApiErrorSchema } },
  }, (request) => run(request, 'watchlist.add', (ownerId) => service.addTv(ownerId, request.params.tmdbId, request.query.locale ?? config.TMDB_LANGUAGE)));
  app.delete<{ Params: TvShowParams }>('/me/watchlist/tv-shows/:tmdbId', {
    schema: { params: TvShowParamsSchema, response: { 200: WatchlistMembershipSchema, 401: ApiErrorSchema } },
  }, (request) => run(request, 'watchlist.remove', (ownerId) => service.removeTv(ownerId, request.params.tmdbId)));
}
