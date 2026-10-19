import { ApiErrorSchema, WhatsAppConfigurationSchema, WhatsAppTestResultSchema } from '@movie-hub/contract';
import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../../config/env.schema.js';
import { readSessionToken } from '../auth/auth.routes.js';
import type { WhatsAppService } from './whatsapp.service.js';

export function registerWhatsAppRoutes(app: FastifyInstance, service: WhatsAppService, config: AppConfig): void {
  const response = { 200: WhatsAppConfigurationSchema, 401: ApiErrorSchema, 409: ApiErrorSchema, 503: ApiErrorSchema };
  // QR images are login credentials; never allow browser/proxy caching.
  app.addHook('onSend', async (request, reply) => {
    if (request.url.startsWith('/api/v1/me/integrations/whatsapp')) reply.header('cache-control', 'no-store');
  });
  app.get('/me/integrations/whatsapp', { schema: { response } }, (request) => {
    return service.get(readSessionToken(request, config.SESSION_COOKIE_NAME));
  });
  app.post('/me/integrations/whatsapp/bind', { schema: { response } }, (request) => {
    return service.start(readSessionToken(request, config.SESSION_COOKIE_NAME));
  });
  app.post(
    '/me/integrations/whatsapp/test',
    {
      schema: {
        response: { 200: WhatsAppTestResultSchema, 401: ApiErrorSchema, 409: ApiErrorSchema, 502: ApiErrorSchema },
      },
    },
    (request) => {
      return service.test(readSessionToken(request, config.SESSION_COOKIE_NAME));
    },
  );
  app.delete(
    '/me/integrations/whatsapp',
    { schema: { response: { 204: { type: 'null' }, 401: ApiErrorSchema, 409: ApiErrorSchema } } },
    async (request, reply) => {
      await service.remove(readSessionToken(request, config.SESSION_COOKIE_NAME));
      return reply.status(204).send();
    },
  );
}
