import {
  ApiErrorSchema,
  TransmissionConfigurationSchema,
  SaveTransmissionConfigurationRequestSchema,
  DownloaderInstanceParamsSchema,
  TransmissionConfigurationListSchema,
  type SaveTransmissionConfigurationRequest,
} from '@movie-hub/contract';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppConfig } from '../../config/env.schema.js';
import { readSessionToken } from '../auth/auth.routes.js';
import type { TransmissionIntegrationService } from './transmission-integration.service.js';

export function registerTransmissionRoutes(
  app: FastifyInstance,
  transmission: TransmissionIntegrationService,
  config: AppConfig
): void {
  const token = (request: FastifyRequest) => readSessionToken(request, config.SESSION_COOKIE_NAME);
  const errorResponses = {
    400: ApiErrorSchema,
    401: ApiErrorSchema,
    404: ApiErrorSchema,
    502: ApiErrorSchema,
    503: ApiErrorSchema,
    504: ApiErrorSchema,
  };

  const instanceParams = DownloaderInstanceParamsSchema;
  app.get('/me/integrations/transmission/instances', {
    schema: { response: { 200: TransmissionConfigurationListSchema, 401: ApiErrorSchema } },
  }, async (request) => transmission.list(token(request)));
  app.post<{ Body: SaveTransmissionConfigurationRequest }>(
    '/me/integrations/transmission/instances',
    { schema: { body: SaveTransmissionConfigurationRequestSchema, response: { 201: TransmissionConfigurationSchema, ...errorResponses } } },
    async (request, reply) => reply.status(201).send(await transmission.create(token(request), request.body))
  );
  app.get<{ Params: { downloaderInstanceId: string } }>(
    '/me/integrations/transmission/instances/:downloaderInstanceId',
    { schema: { params: instanceParams, response: { 200: TransmissionConfigurationSchema, ...errorResponses } } },
    async (request) => transmission.get(token(request), request.params.downloaderInstanceId)
  );
  app.put<{ Params: { downloaderInstanceId: string }; Body: SaveTransmissionConfigurationRequest }>(
    '/me/integrations/transmission/instances/:downloaderInstanceId',
    { schema: { params: instanceParams, body: SaveTransmissionConfigurationRequestSchema, response: { 200: TransmissionConfigurationSchema, ...errorResponses } } },
    async (request) => transmission.save(token(request), request.body, request.params.downloaderInstanceId)
  );
  app.post<{ Params: { downloaderInstanceId: string } }>(
    '/me/integrations/transmission/instances/:downloaderInstanceId/test',
    { schema: { params: instanceParams, response: { 200: TransmissionConfigurationSchema, ...errorResponses } } },
    async (request) => transmission.retest(token(request), request.params.downloaderInstanceId)
  );
  app.delete<{ Params: { downloaderInstanceId: string } }>(
    '/me/integrations/transmission/instances/:downloaderInstanceId',
    { schema: { params: instanceParams, response: { 204: { type: 'null' }, ...errorResponses } } },
    async (request, reply) => {
      await transmission.delete(token(request), request.params.downloaderInstanceId);
      return reply.status(204).send();
    }
  );

  app.get(
    '/me/integrations/transmission',
    {
      schema: { response: { 200: TransmissionConfigurationSchema, 401: ApiErrorSchema } },
    },
    async (request) => transmission.get(token(request))
  );

  app.put<{ Body: SaveTransmissionConfigurationRequest }>(
    '/me/integrations/transmission',
    {
      schema: {
        body: SaveTransmissionConfigurationRequestSchema,
        response: { 200: TransmissionConfigurationSchema, ...errorResponses },
      },
    },
    async (request) => transmission.save(token(request), request.body)
  );

  app.post(
    '/me/integrations/transmission/test',
    {
      schema: { response: { 200: TransmissionConfigurationSchema, ...errorResponses } },
    },
    async (request) => transmission.retest(token(request))
  );

  app.delete(
    '/me/integrations/transmission',
    {
      schema: { response: { 204: { type: 'null' }, 401: ApiErrorSchema } },
    },
    async (request, reply) => {
      await transmission.delete(token(request));
      return reply.status(204).send();
    }
  );
}
