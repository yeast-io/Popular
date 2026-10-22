import { EditSchema } from './preference-edit.schema.js';
import type { FastifyInstance } from 'fastify';
import type { AuthService } from '../auth/auth.service.js';
import { readSessionToken } from '../auth/auth.routes.js';
import type { AppConfig } from '../../config/env.schema.js';
import type { PreferenceService } from './preference.service.js';
import { AppError } from '../../infrastructure/http/app-error.js';

export function registerPreferenceRoutes(
  app: FastifyInstance,
  service: PreferenceService,
  auth: Pick<AuthService, 'requireOwnerId'>,
  config: AppConfig
) {
  const owner = (request: Parameters<typeof readSessionToken>[0]) => {
    return auth.requireOwnerId(readSessionToken(request, config.SESSION_COOKIE_NAME));
  };
  app.get('/me/preferences', async (request) => service.get(await owner(request)));
  app.post('/me/preferences/generate', async (request, reply) => {
    return reply.status(202).send(await service.generate(await owner(request)));
  });
  app.patch('/me/preferences', async (request) => {
    const ownerId = await owner(request);
    const body = EditSchema.safeParse(request.body);
    if (!body.success || (body.data.content !== undefined && !body.data.entryId))
      throw new AppError(400, 'VALIDATION_ERROR', 'Invalid preference edit.');
    const { expectedVersion, ...action } = body.data;
    return service.edit(ownerId, expectedVersion, action);
  });
}
