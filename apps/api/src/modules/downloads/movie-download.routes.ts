import { AiTrace, aiStep, withAiTrace } from '../../infrastructure/logging/ai-trace.js';
import {
  ApiErrorSchema,
  DownloadProviderListResponseSchema,
  CreateMovieDownloadRequestSchema,
  MovieDownloadListResponseSchema,
  MovieDownloadSchema,
  MovieIdParamsSchema,
  type CreateMovieDownloadRequest,
  type MovieIdParams,
} from '@movie-hub/contract';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppConfig } from '../../config/env.schema.js';
import { readSessionToken } from '../auth/auth.routes.js';
import type { MovieDownloadService } from './movie-download.service.js';

export function registerMovieDownloadRoutes(
  app: FastifyInstance,
  service: MovieDownloadService,
  config: AppConfig
): void {
  const token = (request: FastifyRequest) => readSessionToken(request, config.SESSION_COOKIE_NAME);

  app.get(
    '/me/download-providers',
    {
      schema: { response: { 200: DownloadProviderListResponseSchema, 401: ApiErrorSchema } },
    },
    async (request) => service.providers(token(request))
  );

  app.get<{ Params: MovieIdParams }>(
    '/me/movies/:tmdbId/downloads',
    {
      schema: { params: MovieIdParamsSchema, response: { 200: MovieDownloadListResponseSchema, 401: ApiErrorSchema } },
    },
    async (request) => {
      const trace = new AiTrace(
        app.log,
        { requestId: request.id, tmdbId: request.params.tmdbId },
        '',
        'download.sync',
        config.VERBOSE === true
      );
      return withAiTrace(trace, async () => {
        try {
          return await aiStep('download.sync', () => service.listAndSync(token(request), request.params.tmdbId));
        } catch (error) {
          trace.fail(error);
          throw error;
        }
      });
    });

  app.post<{ Params: MovieIdParams; Body: CreateMovieDownloadRequest }>(
    '/me/movies/:tmdbId/downloads',
    {
      schema: {
        params: MovieIdParamsSchema,
        body: CreateMovieDownloadRequestSchema,
        response: {
          201: MovieDownloadSchema,
          400: ApiErrorSchema,
          401: ApiErrorSchema,
          404: ApiErrorSchema,
          409: ApiErrorSchema,
          502: ApiErrorSchema,
          503: ApiErrorSchema,
          504: ApiErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const trace = new AiTrace(
        app.log,
        { requestId: request.id, tmdbId: request.params.tmdbId },
        '',
        'download.create',
        config.VERBOSE === true
      );
      return withAiTrace(trace, async () => {
        try {
          const result = await aiStep('download.create', () => {
            return service.create(
              token(request),
              request.params.tmdbId,
              request.body.sourceReleaseId,
              request.body.provider,
              request.body.sourceProvider,
              request.body.downloaderInstanceId,
              request.body.remoteDeviceId,
              request.headers['accept-language']?.startsWith('zh')
                ? 'zh-CN'
                : request.headers['accept-language']?.startsWith('en') ? 'en-US' : config.TMDB_LANGUAGE,
              request.body.sourceReleaseTitle
            );
          });
          trace.event('download.create.completed', {
            taskId: result.id,
            provider: result.provider,
            outcome: result.status,
          }
          );
          return reply.status(201).send(result);
        } catch (error) {
          trace.fail(error);
          throw error;
        }
      });
    });
}
