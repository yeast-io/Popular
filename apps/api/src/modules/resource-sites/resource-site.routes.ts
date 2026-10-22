import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  ApiErrorSchema,
  ResourceSiteParamsSchema,
  ResourceSiteReleaseParamsSchema,
  ResourceSiteConfigurationSchema,
  SaveResourceSiteSchema,
  ResourceSiteSearchSchema,
  ResourceSiteSearchResultSchema,
  ResourceSiteReleaseSchema,
} from '@movie-hub/contract';
import type {
  ResourceSiteParams,
  ResourceSiteReleaseParams,
  ResourceSiteSearch,
  SaveResourceSite,
} from '@movie-hub/contract';
import type { AuthService } from '../auth/auth.service.js';
import type { ResourceSiteService } from './resource-site.service.js';
import type { AppConfig } from '../../config/env.schema.js';
import type { AiLogger } from '../../infrastructure/logging/ai-trace.types.js';
import { AiTrace, withAiTrace, aiStep } from '../../infrastructure/logging/ai-trace.js';
import { readSessionToken } from '../auth/auth.routes.js';
import { ResourceSiteError } from './resource-site.errors.js';
import { resourceSiteMessages } from './resource-site.messages.js';

export function registerResourceSiteRoutes(
  app: FastifyInstance,
  service: ResourceSiteService,
  auth: AuthService,
  config: AppConfig,
  logger: AiLogger
): void {
  const errors = {
    400: ApiErrorSchema,
    401: ApiErrorSchema,
    409: ApiErrorSchema,
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
    const trace = new AiTrace(logger, { requestId: request.id }, '', 'resource-sites.api', config.VERBOSE);
    return withAiTrace(trace, async () => {
      try {
        const ownerId = await aiStep('resource-sites.auth', () => {
          return auth.requireOwnerId(readSessionToken(request, config.SESSION_COOKIE_NAME));
        });
        return await aiStep(`resource-sites.api.${operation}`, () => action(ownerId, abort.signal));
      } catch (error) {
        trace.fail(error);
        if (error instanceof ResourceSiteError && request.headers['accept-language']?.startsWith('zh'))
          error.message = resourceSiteMessages.zh[error.reason];
        throw error;
      } finally {
        request.raw.socket.removeListener('close', disconnected);
      }
    });
  };
  app.get<{ Params: ResourceSiteParams }>(
    '/me/integrations/resource-sites/:site',
    {
      schema: { params: ResourceSiteParamsSchema, response: { 200: ResourceSiteConfigurationSchema, ...errors } },
    },
    (request) => execute(request, 'configuration', (owner) => service.configuration(owner, request.params.site))
  );
  app.put<{ Params: ResourceSiteParams; Body: SaveResourceSite }>(
    '/me/integrations/resource-sites/:site',
    {
      schema: {
        params: ResourceSiteParamsSchema,
        body: SaveResourceSiteSchema,
        response: { 200: ResourceSiteConfigurationSchema, ...errors },
      },
    },
    (request) => {
      return execute(request, 'configure', (owner) => {
        return service.configure(owner, request.params.site, request.body.cookie, request.body.passkey);
      });
    });
  app.post<{ Params: ResourceSiteParams }>(
    '/me/integrations/resource-sites/:site/test',
    {
      schema: { params: ResourceSiteParamsSchema, response: { 200: ResourceSiteConfigurationSchema, ...errors } },
    },
    (request) => execute(request, 'verify', (owner) => service.configure(owner, request.params.site))
  );
  app.delete<{ Params: ResourceSiteParams }>(
    '/me/integrations/resource-sites/:site',
    {
      schema: { params: ResourceSiteParamsSchema, response: { 204: { type: 'null' }, ...errors } },
    },
    async (request, reply) => {
      await execute(request, 'delete', (owner) => service.delete(owner, request.params.site));
      return reply.code(204).send();
    });
  app.get<{ Params: ResourceSiteParams; Querystring: ResourceSiteSearch }>(
    '/me/resource-sites/:site/releases',
    {
      schema: {
        params: ResourceSiteParamsSchema,
        querystring: ResourceSiteSearchSchema,
        response: { 200: ResourceSiteSearchResultSchema, ...errors },
      },
    },
    (request) => {
      return execute(request, 'search', (owner, signal) => {
        return service.search(owner, request.params.site, request.query, signal);
      });
    });
  app.get<{ Params: ResourceSiteReleaseParams }>(
    '/me/resource-sites/:site/releases/:id',
    {
      schema: { params: ResourceSiteReleaseParamsSchema, response: { 200: ResourceSiteReleaseSchema, ...errors } },
    },
    (request) => {
      return execute(request, 'detail', (owner, signal) => {
        return service.detail(owner, request.params.site, request.params.id, signal);
      });
    });
}
