import { ApiErrorSchema, OpenAIConfigurationSchema, SaveOpenAIConfigurationRequestSchema, type SaveOpenAIConfigurationRequest } from '@movie-hub/contract';
import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../../config/env.js';
import { readSessionToken } from '../auth/auth.routes.js';
import type { OpenAISettingsService } from './openai-settings.service.js';

export function registerOpenAISettingsRoutes(app: FastifyInstance, service: OpenAISettingsService, config: AppConfig): void {
  app.get('/me/integrations/openai', {
    schema: { response: { 200: OpenAIConfigurationSchema, 401: ApiErrorSchema } },
  }, async (request) => service.get(readSessionToken(request, config.SESSION_COOKIE_NAME)));
  app.put<{ Body: SaveOpenAIConfigurationRequest }>('/me/integrations/openai', {
    schema: { body: SaveOpenAIConfigurationRequestSchema, response: { 200: OpenAIConfigurationSchema, 400: ApiErrorSchema, 401: ApiErrorSchema } },
  }, async (request) => service.save(readSessionToken(request, config.SESSION_COOKIE_NAME), request.body.apiKey));
  app.delete('/me/integrations/openai', {
    schema: { response: { 204: { type: 'null' }, 401: ApiErrorSchema } },
  }, async (request, reply) => {
    await service.delete(readSessionToken(request, config.SESSION_COOKIE_NAME));
    return reply.status(204).send();
  });
}
