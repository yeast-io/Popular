import {
  RemoteClientKeySchema,
  RemoteClientUnbindSchema,
  RemoteClientDeviceParamsSchema,
  RemoteClientConfigurationSchema,
  RemoteClientMutationSchema,
  RemoteClientMutationResultSchema,
  ApiErrorSchema,
} from '@movie-hub/contract';
import type { RemoteClientMutation, RemoteClientDeviceParams, RemoteClientUnbind } from '@movie-hub/contract';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppConfig } from '../../config/env.schema.js';
import { AiTrace, withAiTrace } from '../../infrastructure/logging/ai-trace.js';
import type { AiLogger } from '../../infrastructure/logging/ai-trace.types.js';
import type { AuthService } from '../auth/auth.service.js';
import { readSessionToken } from '../auth/auth.routes.js';
import type { RemoteClientService } from './remote-client.service.js';
import type { RemoteClientOperation } from './remote-client.types.js';

export function registerRemoteClientRoutes(
  app: FastifyInstance,
  service: RemoteClientService,
  auth: AuthService,
  config: AppConfig,
  logger: AiLogger
): void {
  const execute = <T>(request: FastifyRequest, action: (ownerId: string) => Promise<T>) => {
    const trace = new AiTrace(logger, { requestId: request.id }, '', 'remote-client', config.VERBOSE);
    return withAiTrace(trace, async () => {
      try {
        const owner = await trace.step('remote-client.auth', () => {
          return auth.requireOwnerId(readSessionToken(request, config.SESSION_COOKIE_NAME));
        });
        return await trace.step('remote-client.execute', () => action(owner));
      } catch (error) {
        trace.fail(error);
        throw error;
      }
    });
  };
  const errors = { 401: ApiErrorSchema, 404: ApiErrorSchema, 409: ApiErrorSchema, 503: ApiErrorSchema };
  const locale = (request: FastifyRequest) => {
    return request.headers['accept-language']?.startsWith('zh')
      ? ('zh-CN' as const)
      : request.headers['accept-language']?.startsWith('en')
        ? ('en-US' as const)
        : config.TMDB_LANGUAGE;
  };
  app.get(
    '/me/remote-client',
    { schema: { response: { 200: RemoteClientConfigurationSchema, ...errors } } },
    (request, reply) => {
      reply.header('cache-control', 'no-store');
      return execute(request, (owner) => service.get(owner));
    });
  app.get(
    '/me/remote-client/key',
    { schema: { response: { 200: RemoteClientKeySchema, ...errors } } },
    (request, reply) => {
      reply.header('cache-control', 'no-store');
      reply.header('pragma', 'no-cache');
      return execute(request, (owner) => service.readKey(owner, locale(request)));
    });
  app.post<{ Params: RemoteClientDeviceParams; Body: RemoteClientUnbind }>(
    '/me/remote-client/devices/:deviceId/unbind',
    {
      schema: {
        params: RemoteClientDeviceParamsSchema,
        body: RemoteClientUnbindSchema,
        response: { 200: RemoteClientConfigurationSchema, 400: ApiErrorSchema, ...errors },
      },
    },
    (request, reply) => {
      reply.header('cache-control', 'no-store');
      return execute(request, (owner) => {
        return service.unbind(owner, request.params.deviceId, request.body, request.id, locale(request));
      });
    });
  for (const operation of ['generate', 'regenerate', 'revoke'] satisfies RemoteClientOperation[]) {
    app.post<{ Body: RemoteClientMutation }>(
      `/me/remote-client/${operation}`,
      {
        schema: {
          body: RemoteClientMutationSchema,
          response: { 200: RemoteClientMutationResultSchema, 400: ApiErrorSchema, ...errors },
        },
      },
      (request, reply) => {
        reply.header('cache-control', 'no-store');
        return execute(request, (owner) => service.change(owner, operation, request.body, request.id, locale(request)));
      });
  }
}
