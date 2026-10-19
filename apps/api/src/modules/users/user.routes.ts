import {
  ApiErrorSchema,
  AuthResponseSchema,
  UpdateProfileRequestSchema,
  type UpdateProfileRequest,
} from '@movie-hub/contract';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppConfig } from '../../config/env.js';
import { readSessionToken } from '../auth/auth.routes.js';
import type { UserService } from './user.service.js';

const avatarContentTypes = ['image/jpeg', 'image/png', 'image/webp'];

export function registerUserRoutes(app: FastifyInstance, service: UserService, config: AppConfig): void {
  app.addContentTypeParser(
    avatarContentTypes,
    { parseAs: 'buffer', bodyLimit: config.AVATAR_MAX_BYTES },
    (_request, body, done) => {
      done(null, body);
    },
  );

  app.patch<{ Body: UpdateProfileRequest }>(
    '/users/me',
    {
      schema: {
        body: UpdateProfileRequestSchema,
        response: { 200: AuthResponseSchema, 400: ApiErrorSchema, 401: ApiErrorSchema },
      },
    },
    async (request) => {
      return { user: await service.updateProfile(token(request, config), request.body) };
    },
  );

  app.put<{ Body: Buffer }>(
    '/users/me/avatar',
    {
      schema: { response: { 200: AuthResponseSchema, 400: ApiErrorSchema, 401: ApiErrorSchema, 413: ApiErrorSchema } },
    },
    async (request) => {
      return { user: await service.uploadAvatar(token(request, config), request.body) };
    },
  );

  app.get(
    '/users/me/avatar',
    {
      schema: { response: { 401: ApiErrorSchema, 404: ApiErrorSchema } },
    },
    async (request, reply) => {
      const avatar = await service.getAvatar(token(request, config));
      reply.header('content-type', avatar.contentType);
      reply.header('cache-control', 'private, max-age=31536000, immutable');
      return reply.send(avatar.stream);
    },
  );

  app.delete(
    '/users/me/avatar',
    {
      schema: { response: { 204: { type: 'null' }, 401: ApiErrorSchema } },
    },
    async (request, reply) => {
      await service.deleteAvatar(token(request, config));
      return reply.status(204).send();
    },
  );
}

function token(request: FastifyRequest, config: AppConfig): string | undefined {
  return readSessionToken(request, config.SESSION_COOKIE_NAME);
}
