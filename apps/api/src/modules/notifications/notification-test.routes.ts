import { ApiErrorSchema, NotificationTestListSchema, NotificationTestResultSchema, SendNotificationTestSchema, type SendNotificationTest } from '@movie-hub/contract';
import type { FastifyInstance } from 'fastify';
import { notificationTestEnabled, type AppConfig } from '../../config/env.js';
import { readSessionToken } from '../auth/auth.routes.js';
import type { NotificationTestService } from './notification-test.service.js';
export function registerNotificationTestRoutes(app: FastifyInstance, service: NotificationTestService, config: AppConfig) {
  if (!notificationTestEnabled(config)) return;
  app.get<{ Querystring: { page?: number } }>('/me/notification-tests/downloads', {
    schema: { querystring: { type: 'object', properties: { page: { type: 'integer', minimum: 1, maximum: 100000 } }, additionalProperties: false }, response: { 200: NotificationTestListSchema, 401: ApiErrorSchema } },
  }, request => service.list(readSessionToken(request, config.SESSION_COOKIE_NAME), request.query.page ?? 1));
  app.post<{ Params: { id: string }; Body: SendNotificationTest }>('/me/notification-tests/downloads/:id/send', {
    schema: { body: SendNotificationTestSchema, params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: '^[a-fA-F0-9]{24}$' } } }, response: { 200: NotificationTestResultSchema, 400: ApiErrorSchema, 401: ApiErrorSchema, 404: ApiErrorSchema, 409: ApiErrorSchema } },
  }, request => service.send(readSessionToken(request, config.SESSION_COOKIE_NAME), request.params.id, request.body.channel));
}
