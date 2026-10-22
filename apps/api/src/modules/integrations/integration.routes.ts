import { AiTrace, aiStep, withAiTrace } from '../../infrastructure/logging/ai-trace.js';
import { localizeSiteAccountError } from '../resource-sites/site-account.errors.js';
import {
  ApiErrorSchema,
  MTeamConfigurationSchema,
  SaveMTeamConfigurationRequestSchema,
  type SaveMTeamConfigurationRequest,
  QBittorrentConfigurationSchema,
  SaveQBittorrentConfigurationRequestSchema,
  DownloaderInstanceParamsSchema,
  QBittorrentConfigurationListSchema,
  type SaveQBittorrentConfigurationRequest,
} from '@movie-hub/contract';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppConfig } from '../../config/env.schema.js';
import { readSessionToken } from '../auth/auth.routes.js';
import type { IntegrationService } from './integration.service.js';
import type { QBittorrentIntegrationService } from './qbittorrent-integration.service.js';

export function registerIntegrationRoutes(
  app: FastifyInstance,
  service: IntegrationService,
  config: AppConfig,
  qbittorrent?: QBittorrentIntegrationService
): void {
  const token = (request: FastifyRequest) => readSessionToken(request, config.SESSION_COOKIE_NAME);
  const errorResponses = {
    400: ApiErrorSchema,
    401: ApiErrorSchema,
    404: ApiErrorSchema,
    409: ApiErrorSchema,
    429: ApiErrorSchema,
    502: ApiErrorSchema,
    503: ApiErrorSchema,
    504: ApiErrorSchema,
  };

  const executeMTeam = <T>(request: FastifyRequest, operation: string, action: () => Promise<T>) => {
    const trace = new AiTrace(app.log, { requestId: request.id }, '', 'mteam.api', config.VERBOSE);
    return withAiTrace(trace, async () => {
      try {
        return await aiStep(`mteam.api.${operation}`, action);
      } catch (error) {
        trace.fail(error);
        localizeSiteAccountError(error, request.headers['accept-language']);
        throw error;
      }
    });
  };

  app.get(
    '/me/integrations/mteam',
    {
      schema: { response: { 200: MTeamConfigurationSchema, 401: ApiErrorSchema } },
    },
    async (request) => service.getMTeam(token(request))
  );

  app.put<{ Body: SaveMTeamConfigurationRequest }>(
    '/me/integrations/mteam',
    {
      schema: {
        body: SaveMTeamConfigurationRequestSchema,
        response: { 200: MTeamConfigurationSchema, ...errorResponses },
      },
    },
    async (request) => executeMTeam(request, 'configure', () => service.saveMTeam(token(request), request.body))
  );

  app.post(
    '/me/integrations/mteam/test',
    {
      schema: { response: { 200: MTeamConfigurationSchema, ...errorResponses } },
    },
    async (request) => executeMTeam(request, 'verify', () => service.retestMTeam(token(request)))
  );

  app.delete(
    '/me/integrations/mteam',
    {
      schema: { response: { 204: { type: 'null' }, 401: ApiErrorSchema } },
    },
    async (request, reply) => {
      await executeMTeam(request, 'delete', () => service.deleteMTeam(token(request)));
      return reply.status(204).send();
    }
  );

  if (!qbittorrent) return;

  const instanceParams = DownloaderInstanceParamsSchema;
  app.get('/me/integrations/qbittorrent/instances', {
    schema: { response: { 200: QBittorrentConfigurationListSchema, 401: ApiErrorSchema } },
  }, async (request) => qbittorrent.list(token(request)));
  app.post<{ Body: SaveQBittorrentConfigurationRequest }>(
    '/me/integrations/qbittorrent/instances',
    { schema: { body: SaveQBittorrentConfigurationRequestSchema, response: { 201: QBittorrentConfigurationSchema, ...errorResponses } } },
    async (request, reply) => reply.status(201).send(await qbittorrent.create(token(request), request.body))
  );
  app.get<{ Params: { downloaderInstanceId: string } }>(
    '/me/integrations/qbittorrent/instances/:downloaderInstanceId',
    { schema: { params: instanceParams, response: { 200: QBittorrentConfigurationSchema, ...errorResponses } } },
    async (request) => qbittorrent.get(token(request), request.params.downloaderInstanceId)
  );
  app.put<{ Params: { downloaderInstanceId: string }; Body: SaveQBittorrentConfigurationRequest }>(
    '/me/integrations/qbittorrent/instances/:downloaderInstanceId',
    { schema: { params: instanceParams, body: SaveQBittorrentConfigurationRequestSchema, response: { 200: QBittorrentConfigurationSchema, ...errorResponses } } },
    async (request) => qbittorrent.save(token(request), request.body, request.params.downloaderInstanceId)
  );
  app.post<{ Params: { downloaderInstanceId: string } }>(
    '/me/integrations/qbittorrent/instances/:downloaderInstanceId/test',
    { schema: { params: instanceParams, response: { 200: QBittorrentConfigurationSchema, ...errorResponses } } },
    async (request) => qbittorrent.retest(token(request), request.params.downloaderInstanceId)
  );
  app.delete<{ Params: { downloaderInstanceId: string } }>(
    '/me/integrations/qbittorrent/instances/:downloaderInstanceId',
    { schema: { params: instanceParams, response: { 204: { type: 'null' }, ...errorResponses } } },
    async (request, reply) => {
      await qbittorrent.delete(token(request), request.params.downloaderInstanceId);
      return reply.status(204).send();
    }
  );

  app.get(
    '/me/integrations/qbittorrent',
    {
      schema: { response: { 200: QBittorrentConfigurationSchema, 401: ApiErrorSchema } },
    },
    async (request) => qbittorrent.get(token(request))
  );

  app.put<{ Body: SaveQBittorrentConfigurationRequest }>(
    '/me/integrations/qbittorrent',
    {
      schema: {
        body: SaveQBittorrentConfigurationRequestSchema,
        response: { 200: QBittorrentConfigurationSchema, ...errorResponses },
      },
    },
    async (request) => qbittorrent.save(token(request), request.body)
  );

  app.post(
    '/me/integrations/qbittorrent/test',
    {
      schema: { response: { 200: QBittorrentConfigurationSchema, ...errorResponses } },
    },
    async (request) => qbittorrent.retest(token(request))
  );

  app.delete(
    '/me/integrations/qbittorrent',
    {
      schema: { response: { 204: { type: 'null' }, 401: ApiErrorSchema } },
    },
    async (request, reply) => {
      await qbittorrent.delete(token(request));
      return reply.status(204).send();
    }
  );
}
