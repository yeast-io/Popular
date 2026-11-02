import type { AiConfiguration } from '@movie-hub/contract';
import {
  ApiErrorSchema,
  SelectAiModelRequestSchema,
  type SelectAiModelRequest,
  AiConfigurationSchema,
  SaveAiConfigurationRequestSchema,
  type SaveAiConfigurationRequest,
} from '@movie-hub/contract';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppConfig } from '../../config/env.schema.js';
import { readSessionToken } from '../auth/auth.routes.js';
import { AiTrace, aiStep, withAiTrace } from '../../infrastructure/logging/ai-trace.js';
import type { AiLogger } from '../../infrastructure/logging/ai-trace.types.js';
import { AppError } from '../../infrastructure/http/app-error.js';
import { aiSettingsMessages } from './ai-settings.messages.js';
import type { AiSettingsService } from './ai-settings.service.js';

export function registerAiSettingsRoutes(
  app: FastifyInstance,
  service: AiSettingsService,
  config: AppConfig,
  logger: AiLogger,
  provider: import('@movie-hub/contract').AiProvider = 'openai'
): void {
  const execute = <T>(request: FastifyRequest, operation: string, action: () => Promise<T>) => {
    const trace = new AiTrace(logger, { requestId: request.id }, '', operation, config.VERBOSE);
    return withAiTrace(trace, async () => {
      try {
        return await aiStep(operation, action);
      } catch (error) {
        trace.fail(error);
        if (error instanceof AppError && request.headers['accept-language']?.startsWith('zh')) {
          const entry = Object.values(aiSettingsMessages).find((message) => message.en === error.message);
          if (entry) error.message = entry.zh;
        }
        throw error;
      }
    });
  };
  app.get(
    `/me/integrations/${provider}`,
    {
      schema: { response: { 200: AiConfigurationSchema, 401: ApiErrorSchema } },
    },
    (request) => execute(request, `${provider}.settings.read`, () => service.get(readSessionToken(request, config.SESSION_COOKIE_NAME)))
  );
  app.put<{ Body: SaveAiConfigurationRequest }>(
    `/me/integrations/${provider}`,
    {
      schema: {
        body: SaveAiConfigurationRequestSchema,
        response: { 200: AiConfigurationSchema, 400: ApiErrorSchema, 401: ApiErrorSchema, 409: ApiErrorSchema, 503: ApiErrorSchema },
      },
    },
    async (request) => {
      return execute(request, `${provider}.settings.verify-save`, () => service.save(readSessionToken(request, config.SESSION_COOKIE_NAME), request.body.apiKey));
    });
  app.put<{ Body: SelectAiModelRequest }>(
    `/me/integrations/${provider}/model`,
    {
      schema: {
        body: SelectAiModelRequestSchema,
        response: {
          200: AiConfigurationSchema,
          400: ApiErrorSchema,
          401: ApiErrorSchema,
          403: ApiErrorSchema,
          409: ApiErrorSchema,
        },
      },
    },
    (request) => {
      return execute(request, `${provider}.settings.model`, () => service.selectModel(readSessionToken(request, config.SESSION_COOKIE_NAME), request.body.model));
    });
  app.post(
    `/me/integrations/${provider}/test`,
    {
      schema: {
        response: {
          200: AiConfigurationSchema,
          401: ApiErrorSchema,
          403: ApiErrorSchema,
          409: ApiErrorSchema,
          503: ApiErrorSchema,
        },
      },
    },
    (request) => execute(request, `${provider}.settings.verify`, () => service.test(readSessionToken(request, config.SESSION_COOKIE_NAME)))
  );
  app.delete(
    `/me/integrations/${provider}`,
    {
      schema: { response: { 204: { type: 'null' }, 401: ApiErrorSchema } },
    },
    async (request, reply) => {
      await execute(request, `${provider}.settings.delete`, () => service.delete(readSessionToken(request, config.SESSION_COOKIE_NAME)));
      return reply.status(204).send();
    });
}

export function registerDefaultAiSettingsRoute(
  app: FastifyInstance, config: AppConfig, logger: AiLogger,
  readDefault: (token: string | undefined) => Promise<AiConfiguration>
): void {
  app.get('/me/integrations/ai', { schema: { response: { 200: AiConfigurationSchema, 401: ApiErrorSchema } } }, async (request) => {
    const trace = new AiTrace(logger, { requestId: request.id }, '', 'ai.settings.default', config.VERBOSE);
    return withAiTrace(trace, async () => {
      try {
        return await aiStep('ai.settings.default', () => readDefault(readSessionToken(request, config.SESSION_COOKIE_NAME)));
      } catch (error) {
        trace.fail(error);
        throw error;
      }
    });
  });
}
