import {
  ApiErrorSchema,
  TransmissionConfigurationSchema,
  SaveTransmissionConfigurationRequestSchema,
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
