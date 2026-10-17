import { ApiErrorSchema, TelegramConfigurationSchema, TelegramBindingSchema, TelegramTestResultSchema } from '@movie-hub/contract';
import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../../config/env.js';
import { readSessionToken } from '../auth/auth.routes.js';
import type { TelegramService } from './telegram.service.js';
export function registerTelegramRoutes(app: FastifyInstance, service: TelegramService, config: AppConfig): void {
  const errors = { 401: ApiErrorSchema, 409: ApiErrorSchema, 502: ApiErrorSchema, 503: ApiErrorSchema };
  app.addHook('onSend', async (request, reply) => {
    if (request.url.startsWith('/api/v1/me/integrations/telegram')) reply.header('cache-control', 'no-store');
  });
  const session = (request: Parameters<typeof readSessionToken>[0]) => readSessionToken(request, config.SESSION_COOKIE_NAME);
  app.get('/me/integrations/telegram', { schema: { response: { 200: TelegramConfigurationSchema, ...errors } } }, request => service.get(session(request)));
  app.post('/me/integrations/telegram/bind', { schema: { response: { 200: TelegramBindingSchema, ...errors } } }, request => service.start(session(request)));
  app.post('/me/integrations/telegram/test', { schema: { response: { 200: TelegramTestResultSchema, ...errors } } }, request => service.test(session(request)));
  app.delete('/me/integrations/telegram', { schema: { response: { 204: { type: 'null' }, ...errors } } }, async (request, reply) => {
    await service.remove(session(request)); return reply.status(204).send();
  });
}
