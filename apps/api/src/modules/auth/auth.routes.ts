import {
  ApiErrorSchema,
  AuthResponseSchema,
  LoginRequestSchema,
  RegisterRequestSchema,
  type LoginRequest,
  type RegisterRequest,
} from '@movie-hub/contract';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppConfig } from '../../config/env.js';
import { AuthService } from './auth.service.js';

export function registerAuthRoutes(app: FastifyInstance, service: AuthService, config: AppConfig): void {
  app.post<{ Body: RegisterRequest }>(
    '/auth/register',
    {
      schema: {
        body: RegisterRequestSchema,
        response: { 201: AuthResponseSchema, 400: ApiErrorSchema, 403: ApiErrorSchema, 409: ApiErrorSchema },
      },
    },
    async (request, reply) => {
      const result = await service.register(request.body);
      reply.header('set-cookie', sessionCookie(config, result.token));
      return reply.status(201).send({ user: result.user });
    },
  );

  app.post<{ Body: LoginRequest }>(
    '/auth/login',
    {
      schema: {
        body: LoginRequestSchema,
        response: { 200: AuthResponseSchema, 400: ApiErrorSchema, 401: ApiErrorSchema },
      },
    },
    async (request, reply) => {
      const result = await service.login(request.body);
      reply.header('set-cookie', sessionCookie(config, result.token));
      return { user: result.user };
    },
  );

  app.get(
    '/auth/me',
    {
      schema: { response: { 200: AuthResponseSchema, 401: ApiErrorSchema } },
    },
    async (request) => {
      return { user: await service.currentUser(readSessionToken(request, config.SESSION_COOKIE_NAME)) };
    },
  );

  app.post('/auth/logout', { schema: { response: { 204: { type: 'null' } } } }, async (request, reply) => {
    await service.logout(readSessionToken(request, config.SESSION_COOKIE_NAME));
    reply.header('set-cookie', clearSessionCookie(config));
    return reply.status(204).send();
  });
}

export function readSessionToken(request: FastifyRequest, cookieName: string): string | undefined {
  const header = request.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0 || part.slice(0, separator).trim() !== cookieName) continue;
    const value = part.slice(separator + 1).trim();
    return value || undefined;
  }
  return undefined;
}

function sessionCookie(config: AppConfig, token: string): string {
  return `${config.SESSION_COOKIE_NAME}=${token}; Path=/api/v1; HttpOnly; SameSite=Lax; Max-Age=${config.SESSION_TTL_SECONDS}${config.SESSION_COOKIE_SECURE ? '; Secure' : ''}`;
}

function clearSessionCookie(config: AppConfig): string {
  return `${config.SESSION_COOKIE_NAME}=; Path=/api/v1; HttpOnly; SameSite=Lax; Max-Age=0${config.SESSION_COOKIE_SECURE ? '; Secure' : ''}`;
}
