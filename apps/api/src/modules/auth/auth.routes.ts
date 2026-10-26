import {
  ApiErrorSchema,
  AuthResponseSchema,
  RegistrationPendingResponseSchema,
  VerifyRegistrationRequestSchema,
  type VerifyRegistrationRequest,
  type Locale,
  LoginRequestSchema,
  RegisterRequestSchema,
  type LoginRequest,
  type RegisterRequest,
} from '@movie-hub/contract';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppConfig } from '../../config/env.schema.js';
import { AiTrace, withAiTrace, aiStep } from '../../infrastructure/logging/ai-trace.js';
import type { AiLogger } from '../../infrastructure/logging/ai-trace.types.js';
import { AuthService } from './auth.service.js';

export function registerAuthRoutes(app: FastifyInstance, service: AuthService, config: AppConfig, logger?: AiLogger): void {
  const execute = async <T>(request: FastifyRequest, stage: string, action: (locale: Locale) => Promise<T>) => {
    const locale: Locale = request.headers['accept-language']?.startsWith('en')
      ? 'en-US'
      : request.headers['accept-language']?.startsWith('zh') ? 'zh-CN' : config.TMDB_LANGUAGE;
    const trace = new AiTrace(logger, { requestId: request.id }, '', 'auth.api', config.VERBOSE);
    const body = request.body as Record<string, unknown> | undefined;
    for (const key of ['email', 'password', 'code']) {
      if (typeof body?.[key] === 'string') trace.sensitive(body[key]);
    }
    return withAiTrace(trace, async () => {
      try {
        return await aiStep(stage, () => action(locale));
      } catch (error) {
        trace.fail(error);
        throw error;
      }
    });
  };
  app.post<{ Body: RegisterRequest }>(
    '/auth/register',
    {
      schema: {
        body: RegisterRequestSchema,
        response: { 202: RegistrationPendingResponseSchema, 429: ApiErrorSchema, 503: ApiErrorSchema, 400: ApiErrorSchema, 403: ApiErrorSchema, 409: ApiErrorSchema },
      },
    },
    async (request, reply) => {
      const result = await execute(request, 'auth.register', (locale) => service.register(request.body, locale));
      return reply.status(202).send(result);
    });

  app.post<{ Body: VerifyRegistrationRequest }>(
    '/auth/verify-email',
    { schema: {
      body: VerifyRegistrationRequestSchema,
      response: { 200: AuthResponseSchema, 400: ApiErrorSchema, 403: ApiErrorSchema, 409: ApiErrorSchema, 503: ApiErrorSchema },
    } },
    async (request, reply) => {
      const result = await execute(request, 'auth.verify-email', (locale) => service.verifyRegistration(request.body, locale));
      reply.header('set-cookie', sessionCookie(config, result.token));
      return { user: result.user };
    });

  app.post<{ Body: LoginRequest }>(
    '/auth/login',
    {
      schema: {
        body: LoginRequestSchema,
        response: { 200: AuthResponseSchema, 400: ApiErrorSchema, 401: ApiErrorSchema },
      },
    },
    async (request, reply) => {
      const result = await execute(request, 'auth.login', () => service.login(request.body));
      reply.header('set-cookie', sessionCookie(config, result.token));
      return { user: result.user };
    });

  app.get(
    '/auth/me',
    {
      schema: { response: { 200: AuthResponseSchema, 401: ApiErrorSchema } },
    },
    async (request) => {
      return { user: await service.currentUser(readSessionToken(request, config.SESSION_COOKIE_NAME)) };
    });

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
