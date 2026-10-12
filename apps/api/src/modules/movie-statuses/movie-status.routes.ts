import {
  ApiErrorSchema, MovieIdParamsSchema, MovieStatusResponseSchema, MyMoviesQuerySchema, MyMoviesResponseSchema,
  SetMovieStatusRequestSchema, type MovieIdParams, type MyMoviesQuery, type SetMovieStatusRequest,
} from '@movie-hub/contract';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppConfig } from '../../config/env.js';
import { readSessionToken } from '../auth/auth.routes.js';
import type { AuthService } from '../auth/auth.service.js';
import type { MovieStatusService } from './movie-status.service.js';

export function registerMovieStatusRoutes(app: FastifyInstance, service: MovieStatusService, auth: AuthService, config: AppConfig): void {
  const ownerId = (request: FastifyRequest) => auth.requireOwnerId(readSessionToken(request, config.SESSION_COOKIE_NAME));

  app.put<{ Params: MovieIdParams; Body: SetMovieStatusRequest }>('/me/movies/:tmdbId/status', {
    schema: { params: MovieIdParamsSchema, body: SetMovieStatusRequestSchema, response: { 200: MovieStatusResponseSchema, 401: ApiErrorSchema, 404: ApiErrorSchema } },
  }, async (request) => service.set(await ownerId(request), request.params.tmdbId, request.body.status));

  app.delete<{ Params: MovieIdParams }>('/me/movies/:tmdbId/status', {
    schema: { params: MovieIdParamsSchema, response: { 200: MovieStatusResponseSchema, 401: ApiErrorSchema } },
  }, async (request) => service.clear(await ownerId(request), request.params.tmdbId));

  app.get<{ Querystring: MyMoviesQuery }>('/me/movies', {
    schema: { querystring: MyMoviesQuerySchema, response: { 200: MyMoviesResponseSchema, 401: ApiErrorSchema } },
  }, async (request) => service.list(
    await ownerId(request), request.query.status, request.query.page ?? 1, request.query.pageSize ?? 20, request.query.locale,
  ));
}
