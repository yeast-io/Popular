import { ApiErrorSchema, MovieIdParamsSchema, MoviePreferenceResponseSchema, MovieReleaseListResponseSchema, MovieResourceCheckResponseSchema, MovieResourceSyncBatchSchema, MovieResourceSyncParamsSchema, MovieStatusResponseSchema, MyMoviesQuerySchema, MyMoviesResponseSchema, StartMovieResourceSyncRequestSchema, SetMoviePreferenceRequestSchema, SetMovieStatusRequestSchema, type MovieIdParams, type MovieResourceSyncParams, type MyMoviesQuery, type SetMoviePreferenceRequest, type SetMovieStatusRequest, type StartMovieResourceSyncRequest } from '@movie-hub/contract';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppConfig } from '../../config/env.schema.js';
import { readSessionToken } from '../auth/auth.routes.js';
import type { AuthService } from '../auth/auth.service.js';
import type { MovieStatusService } from './movie-status.service.js';
import type { MovieResourceSyncService } from '../integrations/movie-resource-sync.service.js';

export function registerMovieStatusRoutes(
  app: FastifyInstance,
  service: MovieStatusService,
  auth: AuthService,
  config: AppConfig,
  sync?: MovieResourceSyncService,
): void {
  const ownerId = (request: FastifyRequest) => {
    return auth.requireOwnerId(readSessionToken(request, config.SESSION_COOKIE_NAME));
  };

  app.put<{ Params: MovieIdParams; Body: SetMovieStatusRequest }>(
    '/me/movies/:tmdbId/status',
    {
      schema: {
        params: MovieIdParamsSchema,
        body: SetMovieStatusRequestSchema,
        response: { 200: MovieStatusResponseSchema, 401: ApiErrorSchema, 404: ApiErrorSchema },
      },
    },
    async (request) => {
      return service.set(await ownerId(request), request.params.tmdbId, request.body.status);
    },
  );

  app.delete<{ Params: MovieIdParams }>(
    '/me/movies/:tmdbId/status',
    {
      schema: { params: MovieIdParamsSchema, response: { 200: MovieStatusResponseSchema, 401: ApiErrorSchema } },
    },
    async (request) => service.clear(await ownerId(request), request.params.tmdbId),
  );

  app.put<{ Params: MovieIdParams; Body: SetMoviePreferenceRequest }>(
    '/me/movies/:tmdbId/preference',
    {
      schema: {
        params: MovieIdParamsSchema,
        body: SetMoviePreferenceRequestSchema,
        response: { 200: MoviePreferenceResponseSchema, 401: ApiErrorSchema, 404: ApiErrorSchema },
      },
    },
    async (request) => {
      return service.setPreference(await ownerId(request), request.params.tmdbId, request.body.preference);
    },
  );

  app.delete<{ Params: MovieIdParams }>(
    '/me/movies/:tmdbId/preference',
    {
      schema: { params: MovieIdParamsSchema, response: { 200: MoviePreferenceResponseSchema, 401: ApiErrorSchema } },
    },
    async (request) => service.clearPreference(await ownerId(request), request.params.tmdbId),
  );

  app.get<{ Querystring: MyMoviesQuery }>(
    '/me/movies',
    {
      schema: { querystring: MyMoviesQuerySchema, response: { 200: MyMoviesResponseSchema, 401: ApiErrorSchema } },
    },
    async (request) => {
      return service.list(
        await ownerId(request),
        request.query.status,
        request.query.page ?? 1,
        request.query.pageSize ?? 20,
        request.query.locale,
      );
    },
  );

  app.get<{ Params: MovieIdParams }>(
    '/me/movies/:tmdbId/resources/mteam',
    {
      schema: { params: MovieIdParamsSchema, response: { 200: MovieResourceCheckResponseSchema, 401: ApiErrorSchema } },
    },
    async (request) => service.resourceCheck(await ownerId(request), request.params.tmdbId),
  );

  app.post<{ Params: MovieIdParams }>(
    '/me/movies/:tmdbId/resources/mteam/refresh',
    {
      schema: {
        params: MovieIdParamsSchema,
        response: {
          202: MovieResourceCheckResponseSchema,
          401: ApiErrorSchema,
          404: ApiErrorSchema,
          409: ApiErrorSchema,
          503: ApiErrorSchema,
        },
      },
    },
    async (request, reply) => {
      return reply.status(202).send(await service.recheckResource(await ownerId(request), request.params.tmdbId));
    },
  );

  app.get<{ Params: MovieIdParams }>(
    '/me/movies/:tmdbId/resources/mteam/releases',
    {
      schema: {
        params: MovieIdParamsSchema,
        response: {
          200: MovieReleaseListResponseSchema,
          401: ApiErrorSchema,
          404: ApiErrorSchema,
          409: ApiErrorSchema,
          429: ApiErrorSchema,
          502: ApiErrorSchema,
          503: ApiErrorSchema,
          504: ApiErrorSchema,
        },
      },
    },
    async (request) => service.releases(await ownerId(request), request.params.tmdbId),
  );

  if (sync) {
    app.post<{ Body: StartMovieResourceSyncRequest }>(
      '/me/movies/resources/mteam/sync',
      {
        schema: {
          body: StartMovieResourceSyncRequestSchema,
          response: { 202: MovieResourceSyncBatchSchema, 401: ApiErrorSchema },
        },
      },
      async (request, reply) => reply.status(202).send(await sync.start(await ownerId(request))),
    );

    app.get<{ Params: MovieResourceSyncParams }>(
      '/me/movies/resources/mteam/sync/:jobId',
      {
        schema: {
          params: MovieResourceSyncParamsSchema,
          response: { 200: MovieResourceSyncBatchSchema, 401: ApiErrorSchema, 404: ApiErrorSchema },
        },
      },
      async (request) => sync.get(await ownerId(request), request.params.jobId),
    );
  }
}
