import { AppError } from '../../infrastructure/http/app-error.js';
import { resourceSearchMessages } from './resource-search.messages.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  ApiErrorSchema,
  ResourceSearchSourcesSchema,
  ResourceSiteParamsSchema,
  ResourceSiteReleaseParamsSchema,
  ResourceSiteSearchSchema,
  ResourceSiteSearchResultSchema,
  ResourceSiteReleaseSchema,
} from '@movie-hub/contract';
import type { ResourceSiteParams, ResourceSiteReleaseParams, ResourceSiteSearch } from '@movie-hub/contract';
import type { AuthService } from '../auth/auth.service.js';
import type { AppConfig } from '../../config/env.schema.js';
import type { AiLogger } from '../../infrastructure/logging/ai-trace.types.js';
import { AiTrace, withAiTrace, aiStep } from '../../infrastructure/logging/ai-trace.js';
import { readSessionToken } from '../auth/auth.routes.js';
import { ResourceSiteError } from '../resource-sites/resource-site.errors.js';
import { resourceSiteMessages } from '../resource-sites/resource-site.messages.js';
import type { ResourceSearchService } from './resource-search.service.js';

export function registerResourceSearchRoutes(
  app: FastifyInstance,
  service: ResourceSearchService,
  auth: AuthService,
  config: AppConfig,
  logger: AiLogger
): void {
  const errors = {
    400: ApiErrorSchema,
    401: ApiErrorSchema,
    409: ApiErrorSchema,
    429: ApiErrorSchema,
    502: ApiErrorSchema,
    504: ApiErrorSchema,
  };
  const execute = async <T>(
    request: FastifyRequest,
    operation: string,
    action: (ownerId: string, signal: AbortSignal) => Promise<T>
  ) => {
    const abort = new AbortController();
    const disconnected = () => abort.abort();
    request.raw.socket.once('close', disconnected);
    const trace = new AiTrace(logger, { requestId: request.id }, '', 'resource-search.api', config.VERBOSE);
    return withAiTrace(trace, async () => {
      try {
        const ownerId = await aiStep('resource-search.auth', () => {
          return auth.requireOwnerId(readSessionToken(request, config.SESSION_COOKIE_NAME));
        });
        return await aiStep(`resource-search.api.${operation}`, () => action(ownerId, abort.signal));
      } catch (error) {
        trace.fail(error);
        if (error instanceof AppError && error.code === 'INTEGRATION_DEFAULT_INVALID' && request.headers['accept-language']?.startsWith('zh'))
          error.message = resourceSearchMessages.zh.disabledSource;
        if (error instanceof ResourceSiteError && request.headers['accept-language']?.startsWith('zh'))
          error.message = resourceSiteMessages.zh[error.reason];
        throw error;
      } finally {
        request.raw.socket.removeListener('close', disconnected);
      }
    });
  };

  app.get(
    '/me/resource-search/sources',
    { schema: { response: { 200: ResourceSearchSourcesSchema, ...errors } } },
    (request) => execute(request, 'sources', (owner) => service.list(owner))
  );
  app.get<{ Params: ResourceSiteParams; Querystring: ResourceSiteSearch }>(
    '/me/resource-search/:site/releases',
    {
      schema: {
        params: ResourceSiteParamsSchema,
        querystring: ResourceSiteSearchSchema,
        response: { 200: ResourceSiteSearchResultSchema, ...errors, 404: ApiErrorSchema },
      },
    },
    (request) => {
      return execute(request, 'search', (owner, signal) => {
        return service.search(owner, request.params.site, request.query, signal,
          request.headers['accept-language']?.startsWith('zh')
            ? 'zh-CN'
            : request.headers['accept-language']?.startsWith('en') ? 'en-US' : config.TMDB_LANGUAGE);
      });
    });
  app.get<{ Params: ResourceSiteReleaseParams }>(
    '/me/resource-search/:site/releases/:id',
    {
      schema: {
        params: ResourceSiteReleaseParamsSchema,
        response: { 200: ResourceSiteReleaseSchema, ...errors, 404: ApiErrorSchema },
      },
    },
    (request) => {
      return execute(request, 'detail', (owner, signal) => {
        return service.detail(owner, request.params.site, request.params.id, signal);
      });
    });
}
