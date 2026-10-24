import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ApiErrorSchema, TvShowParamsSchema, TvLocaleQuerySchema, SetMoviePreferenceRequestSchema, MoviePreferenceResponseSchema } from '@movie-hub/contract';
import type { TvShowParams, TvLocaleQuery, SetMoviePreferenceRequest } from '@movie-hub/contract';
import type { AuthService } from '../auth/auth.service.js';
import type { AppConfig } from '../../config/env.schema.js';
import type { AiLogger } from '../../infrastructure/logging/ai-trace.types.js';
import type { TvPreferenceService } from './tv-preference.service.js';
import { readSessionToken } from '../auth/auth.routes.js';
import { AiTrace, withAiTrace, aiStep } from '../../infrastructure/logging/ai-trace.js';

export function registerTvPreferenceRoutes(app: FastifyInstance, service: TvPreferenceService, auth: AuthService, config: AppConfig, logger: AiLogger) {
  async function run<T>(request: FastifyRequest, stage: string, action: (ownerId: string) => Promise<T>) {
    const trace = new AiTrace(logger, { requestId: request.id, correlationId: request.id }, '', 'tv.preference.api', config.VERBOSE);
    return withAiTrace(trace, async () => {
      try {
        return await aiStep(stage, async () => action(await auth.requireOwnerId(readSessionToken(request, config.SESSION_COOKIE_NAME))));
      } catch (error) {
        trace.fail(error);
        throw error;
      }
    });
  }
  app.put<{ Params: TvShowParams; Querystring: TvLocaleQuery; Body: SetMoviePreferenceRequest }>('/me/tv-shows/:tmdbId/preference', {
    schema: { params: TvShowParamsSchema, querystring: TvLocaleQuerySchema, body: SetMoviePreferenceRequestSchema, response: { 200: MoviePreferenceResponseSchema, 401: ApiErrorSchema, 404: ApiErrorSchema } },
  }, (request) => run(request, 'tv.preference.set', (ownerId) => service.set(ownerId, request.params.tmdbId, request.body.preference, request.query.locale ?? config.TMDB_LANGUAGE)));
  app.delete<{ Params: TvShowParams }>('/me/tv-shows/:tmdbId/preference', {
    schema: { params: TvShowParamsSchema, response: { 200: MoviePreferenceResponseSchema, 401: ApiErrorSchema } },
  }, (request) => run(request, 'tv.preference.remove', (ownerId) => service.clear(ownerId, request.params.tmdbId)));
}
