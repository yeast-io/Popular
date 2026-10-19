import { ApiErrorSchema, MTeamConfigurationSchema, SaveMTeamConfigurationRequestSchema, type SaveMTeamConfigurationRequest, QBittorrentConfigurationSchema, SaveQBittorrentConfigurationRequestSchema, type SaveQBittorrentConfigurationRequest } from '@movie-hub/contract';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppConfig } from '../../config/env.schema.js';
import { readSessionToken } from '../auth/auth.routes.js';
import type { IntegrationService } from './integration.service.js';
import type { QBittorrentIntegrationService } from './qbittorrent-integration.service.js';

export function registerIntegrationRoutes(
  app: FastifyInstance,
  service: IntegrationService,
  config: AppConfig,
  qbittorrent?: QBittorrentIntegrationService,
): void {
  const token = (request: FastifyRequest) => readSessionToken(request, config.SESSION_COOKIE_NAME);
  const errorResponses = {
    400: ApiErrorSchema,
    401: ApiErrorSchema,
    404: ApiErrorSchema,
    429: ApiErrorSchema,
    502: ApiErrorSchema,
    503: ApiErrorSchema,
    504: ApiErrorSchema,
  };

  app.get(
    '/me/integrations/mteam',
    {
      schema: { response: { 200: MTeamConfigurationSchema, 401: ApiErrorSchema } },
    },
    async (request) => service.getMTeam(token(request)),
  );

  app.put<{ Body: SaveMTeamConfigurationRequest }>(
    '/me/integrations/mteam',
    {
      schema: {
        body: SaveMTeamConfigurationRequestSchema,
        response: { 200: MTeamConfigurationSchema, ...errorResponses },
      },
    },
    async (request) => service.saveMTeam(token(request), request.body),
  );

  app.post(
    '/me/integrations/mteam/test',
    {
      schema: { response: { 200: MTeamConfigurationSchema, ...errorResponses } },
    },
    async (request) => service.retestMTeam(token(request)),
  );

  app.delete(
    '/me/integrations/mteam',
    {
      schema: { response: { 204: { type: 'null' }, 401: ApiErrorSchema } },
    },
    async (request, reply) => {
      await service.deleteMTeam(token(request));
      return reply.status(204).send();
    },
  );

  if (!qbittorrent) return;

  app.get(
    '/me/integrations/qbittorrent',
    {
      schema: { response: { 200: QBittorrentConfigurationSchema, 401: ApiErrorSchema } },
    },
    async (request) => qbittorrent.get(token(request)),
  );

  app.put<{ Body: SaveQBittorrentConfigurationRequest }>(
    '/me/integrations/qbittorrent',
    {
      schema: {
        body: SaveQBittorrentConfigurationRequestSchema,
        response: { 200: QBittorrentConfigurationSchema, ...errorResponses },
      },
    },
    async (request) => qbittorrent.save(token(request), request.body),
  );

  app.post(
    '/me/integrations/qbittorrent/test',
    {
      schema: { response: { 200: QBittorrentConfigurationSchema, ...errorResponses } },
    },
    async (request) => qbittorrent.retest(token(request)),
  );

  app.delete(
    '/me/integrations/qbittorrent',
    {
      schema: { response: { 204: { type: 'null' }, 401: ApiErrorSchema } },
    },
    async (request, reply) => {
      await qbittorrent.delete(token(request));
      return reply.status(204).send();
    },
  );
}
