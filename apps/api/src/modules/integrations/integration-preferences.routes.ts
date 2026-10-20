import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ApiErrorSchema, IntegrationPreferencesSchema, SetIntegrationDefaultSchema, SetResourceSelectionSchema,
  MovieIdParamsSchema, MovieResourceCheckResponseSchema, MovieSiteResourceParamsSchema, MovieSiteResourceQuerySchema,
  MovieSiteReleaseListSchema, MovieResourceSyncBatchSchema, MovieResourceSyncParamsSchema, StartMovieResourceSyncRequestSchema } from '@movie-hub/contract';
import type { SetIntegrationDefault, SetResourceSelection, MovieIdParams, MovieSiteResourceParams, MovieSiteResourceQuery, MovieResourceSyncParams } from '@movie-hub/contract';
import type { AppConfig } from '../../config/env.schema.js';
import type { AiLogger } from '../../infrastructure/logging/ai-trace.types.js';
import { AiTrace, aiStep, withAiTrace } from '../../infrastructure/logging/ai-trace.js';
import type { AuthService } from '../auth/auth.service.js';
import { readSessionToken } from '../auth/auth.routes.js';
import type { IntegrationPreferencesService } from './integration-preferences.service.js';
import type { MovieSiteResourcesService } from './movie-site-resources.service.js';
import type { MovieResourceSyncService } from './movie-resource-sync.service.js';
import { integrationPreferencesMessages as messages } from './integration-preferences.messages.js';
import { AppError } from '../../infrastructure/http/app-error.js';

export function registerIntegrationPreferencesRoutes(app: FastifyInstance, preferences: IntegrationPreferencesService,
  auth: AuthService, config: AppConfig, logger: AiLogger, resources?: MovieSiteResourcesService, sync?: MovieResourceSyncService): void {
  const errors = { 400: ApiErrorSchema, 401: ApiErrorSchema, 404: ApiErrorSchema, 409: ApiErrorSchema, 429: ApiErrorSchema, 502: ApiErrorSchema, 503: ApiErrorSchema, 504: ApiErrorSchema };
  const execute = <T>(request: FastifyRequest, operation: string, action: (ownerId: string) => Promise<T>) => {
    const trace = new AiTrace(logger, { requestId: request.id }, '', operation, config.VERBOSE);
    return withAiTrace(trace, async () => {
      try {
        const ownerId = await aiStep(
          'integration-preferences.auth',
          () => auth.requireOwnerId(readSessionToken(request, config.SESSION_COOKIE_NAME))
        );
        return await aiStep(operation, () => action(ownerId));
      } catch (error) {
        trace.fail(error);
        if (error instanceof AppError && request.headers['accept-language']?.startsWith('zh')) {
          if (error.message === messages.en.invalid) error.message = messages.zh.invalid;
          if (error.message === messages.en.replacement) error.message = messages.zh.replacement;
        }
        throw error;
      }
    });
  };
  app.get('/me/integration-preferences', { schema: { response: { 200: IntegrationPreferencesSchema, ...errors } } },
    (request) => execute(request, 'integration-preferences.read', (owner) => preferences.get(owner)));
  app.put<{ Body: SetIntegrationDefault }>('/me/integration-preferences/default', {
    schema: { body: SetIntegrationDefaultSchema, response: { 200: IntegrationPreferencesSchema, ...errors } },
  }, (request) => {
    return execute(
      request, 'integration-preferences.default',
      (owner) => preferences.setDefault(owner, request.body.category, request.body.id)
    );
  });
  app.put<{ Body: SetResourceSelection }>('/me/integration-preferences/resource-sites', {
    schema: { body: SetResourceSelectionSchema, response: { 200: IntegrationPreferencesSchema, ...errors } },
  }, (request) => {
    return execute(
      request, 'integration-preferences.selection',
      (owner) => preferences.selectSites(owner, request.body.sites)
    );
  });
  if (resources) {
    app.get<{ Params: MovieIdParams }>('/me/movies/:tmdbId/resources', {
      schema: { params: MovieIdParamsSchema, response: { 200: MovieResourceCheckResponseSchema, ...errors } },
    }, (request) => {
      return execute(request, 'movie-resources.summary', (owner) => resources.summary(owner, request.params.tmdbId));
    });
    app.post<{ Params: MovieIdParams }>('/me/movies/:tmdbId/resources/refresh', {
      schema: { params: MovieIdParamsSchema, response: { 202: MovieResourceCheckResponseSchema, ...errors } },
    }, async (request, reply) => {
      return reply.status(202).send(await execute(request, 'movie-resources.refresh', async (owner) => {
        await resources.request(owner, request.params.tmdbId);
        return resources.summary(owner, request.params.tmdbId);
      })
      );
    });
    app.get<{ Params: MovieSiteResourceParams; Querystring: MovieSiteResourceQuery }>('/me/movies/:tmdbId/resources/:site/releases', {
      schema: { params: MovieSiteResourceParamsSchema, querystring: MovieSiteResourceQuerySchema, response: { 200: MovieSiteReleaseListSchema, ...errors } },
    }, (request) => {
      return execute(
        request, 'movie-resources.releases',
        (owner) => resources.listReleases(owner, request.params.tmdbId, request.params.site, request.query.page)
      );
    });
    app.post<{ Params: MovieSiteResourceParams }>('/me/movies/:tmdbId/resources/:site/releases/refresh', {
      schema: { params: MovieSiteResourceParamsSchema, response: { 200: MovieSiteReleaseListSchema, ...errors } },
    }, (request) => {
      return execute(request, 'movie-resources.site.refresh', (owner) => {
        return aiStep('movie-resources.site.refresh.fetch', () => {
          return resources.listReleases(owner, request.params.tmdbId, request.params.site, 1, true);
        }, { tmdbId: request.params.tmdbId, site: request.params.site, force: true }
        );
      });
    });
  }
  if (sync) {
    app.post('/me/movies/resources/sync', {
      schema: { body: StartMovieResourceSyncRequestSchema, response: { 202: MovieResourceSyncBatchSchema, ...errors } },
    }, async (request, reply) => {
      return reply.status(202).send(await execute(request, 'movie-resources.sync.start', (owner) => sync.start(owner)));
    });
    app.get<{ Params: MovieResourceSyncParams }>('/me/movies/resources/sync/:jobId', {
      schema: { params: MovieResourceSyncParamsSchema, response: { 200: MovieResourceSyncBatchSchema, ...errors } },
    }, (request) => execute(request, 'movie-resources.sync.read', (owner) => sync.get(owner, request.params.jobId)));
  }
}
