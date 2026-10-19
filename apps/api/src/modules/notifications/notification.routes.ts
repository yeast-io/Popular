import {
  ApiErrorSchema,
  NotificationPreferencesSchema,
  SaveNotificationPreferencesSchema,
  type SaveNotificationPreferences,
} from '@movie-hub/contract';
import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../../config/env.js';
import { readSessionToken } from '../auth/auth.routes.js';
import type { NotificationService } from './notification.service.js';
export function registerNotificationRoutes(
  app: FastifyInstance,
  service: NotificationService,
  config: AppConfig,
): void {
  const response = {
    200: NotificationPreferencesSchema,
    400: ApiErrorSchema,
    401: ApiErrorSchema,
    409: ApiErrorSchema,
  };
  app.get('/me/notifications', { schema: { response } }, (request) => {
    return service.get(readSessionToken(request, config.SESSION_COOKIE_NAME));
  });
  app.put<{ Body: SaveNotificationPreferences }>(
    '/me/notifications',
    { schema: { body: SaveNotificationPreferencesSchema, response } },
    (request) => {
      return service.save(readSessionToken(request, config.SESSION_COOKIE_NAME), request.body);
    },
  );
}
