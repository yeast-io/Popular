import {
  ApiErrorSchema,
  LoadMoreTrendingRequestSchema,
  MovieDetailParamsSchema,
  MovieDetailQuerySchema,
  MovieDetailSchema,
  SearchMoviesQuerySchema,
  SearchMoviesResponseSchema,
  TrendingMoviesResponseSchema,
  TrendingQuerySchema,
  type LoadMoreTrendingRequest,
  type MovieDetailParams,
  type MovieDetailQuery,
  type SearchMoviesQuery,
  type TrendingQuery,
} from '@movie-hub/contract';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppConfig } from '../../config/env.schema.js';
import { readSessionToken } from '../auth/auth.routes.js';
import type { AuthService } from '../auth/auth.service.js';
import type { MovieService } from './movie.service.js';

export function registerMovieRoutes(
  app: FastifyInstance,
  service: MovieService,
  auth?: AuthService,
  config?: AppConfig
): void {
  app.get<{ Querystring: TrendingQuery }>(
    '/movies/trending',
    {
      schema: {
        querystring: TrendingQuerySchema,
        response: { 200: TrendingMoviesResponseSchema, 409: ApiErrorSchema, 503: ApiErrorSchema },
      },
    },
    async (request) => {
      return service.trending(
        request.query.page ?? 1,
        resolveLocale(request.query.locale, config),
        await optionalOwnerId(request, auth, config)
      );
    });

  app.get<{ Querystring: SearchMoviesQuery }>(
    '/movies/search',
    {
      schema: {
        querystring: SearchMoviesQuerySchema,
        response: { 200: SearchMoviesResponseSchema, 400: ApiErrorSchema, 503: ApiErrorSchema },
      },
    },
    async (request) => {
      return service.search(
        request.query.query,
        request.query.page ?? 1,
        resolveLocale(request.query.locale, config),
        await optionalOwnerId(request, auth, config)
      );
    });

  app.get<{ Params: MovieDetailParams; Querystring: MovieDetailQuery }>(
    '/movies/:tmdbId',
    {
      schema: {
        params: MovieDetailParamsSchema,
        querystring: MovieDetailQuerySchema,
        response: { 200: MovieDetailSchema, 503: ApiErrorSchema },
      },
    },
    async (request) => {
      return service.detail(
        request.params.tmdbId,
        resolveLocale(request.query.locale, config),
        await optionalOwnerId(request, auth, config)
      );
    });

  app.post<{ Body: LoadMoreTrendingRequest }>(
    '/movies/trending/load-more',
    {
      schema: {
        body: LoadMoreTrendingRequestSchema,
        response: { 200: TrendingMoviesResponseSchema, 400: ApiErrorSchema, 409: ApiErrorSchema, 503: ApiErrorSchema },
      },
    },
    async (request) => {
      return service.loadMore(
        request.body.page,
        request.body.generation,
        resolveLocale(request.body.locale, config),
        await optionalOwnerId(request, auth, config)
      );
    });
}

function resolveLocale(locale: TrendingQuery['locale'], config?: AppConfig): NonNullable<TrendingQuery['locale']> {
  return locale ?? config?.TMDB_LANGUAGE ?? 'zh-CN';
}

async function optionalOwnerId(
  request: FastifyRequest,
  auth?: AuthService,
  config?: AppConfig
): Promise<string | null> {
  if (!auth || !config) return null;
  return auth.optionalOwnerId(readSessionToken(request, config.SESSION_COOKIE_NAME));
}
