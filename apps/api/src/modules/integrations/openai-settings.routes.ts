import {
  ApiErrorSchema,
  SelectOpenAIModelRequestSchema,
  type SelectOpenAIModelRequest,
  OpenAIConfigurationSchema,
  SaveOpenAIConfigurationRequestSchema,
  type SaveOpenAIConfigurationRequest,
} from '@movie-hub/contract';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppConfig } from '../../config/env.schema.js';
import { readSessionToken } from '../auth/auth.routes.js';
import { AiTrace, aiStep, withAiTrace } from '../../infrastructure/logging/ai-trace.js';
import type { AiLogger } from '../../infrastructure/logging/ai-trace.types.js';
import { AppError } from '../../infrastructure/http/app-error.js';
import { openAISettingsMessages } from './openai-settings.messages.js';
import type { OpenAISettingsService } from './openai-settings.service.js';

export function registerOpenAISettingsRoutes(
  app: FastifyInstance,
  service: OpenAISettingsService,
  config: AppConfig,
  logger: AiLogger
): void {
  const execute = <T>(request: FastifyRequest, operation: string, action: () => Promise<T>) => {
    const trace = new AiTrace(logger, { requestId: request.id }, '', operation, config.VERBOSE);
    return withAiTrace(trace, async () => {
      try {
        return await aiStep(operation, action);
      } catch (error) {
        trace.fail(error);
        if (error instanceof AppError && request.headers['accept-language']?.startsWith('zh')) {
          const entry = Object.values(openAISettingsMessages).find((message) => message.en === error.message);
          if (entry) error.message = entry.zh;
        }
        throw error;
      }
    });
  };
  app.get(
    '/me/integrations/openai',
    {
      schema: { response: { 200: OpenAIConfigurationSchema, 401: ApiErrorSchema } },
    },
    (request) => execute(request, 'openai.settings.read', () => service.get(readSessionToken(request, config.SESSION_COOKIE_NAME)))
  );
  app.put<{ Body: SaveOpenAIConfigurationRequest }>(
    '/me/integrations/openai',
    {
      schema: {
        body: SaveOpenAIConfigurationRequestSchema,
        response: { 200: OpenAIConfigurationSchema, 400: ApiErrorSchema, 401: ApiErrorSchema, 409: ApiErrorSchema, 503: ApiErrorSchema },
      },
    },
    async (request) => {
      return execute(request, 'openai.settings.verify-save', () => service.save(readSessionToken(request, config.SESSION_COOKIE_NAME), request.body.apiKey));
    });
  app.put<{ Body: SelectOpenAIModelRequest }>(
    '/me/integrations/openai/model',
    {
      schema: {
        body: SelectOpenAIModelRequestSchema,
        response: {
          200: OpenAIConfigurationSchema,
          400: ApiErrorSchema,
          401: ApiErrorSchema,
          403: ApiErrorSchema,
          409: ApiErrorSchema,
        },
      },
    },
    (request) => {
      return execute(request, 'openai.settings.model', () => service.selectModel(readSessionToken(request, config.SESSION_COOKIE_NAME), request.body.model));
    });
  app.post(
    '/me/integrations/openai/test',
    {
      schema: {
        response: {
          200: OpenAIConfigurationSchema,
          401: ApiErrorSchema,
          403: ApiErrorSchema,
          409: ApiErrorSchema,
          503: ApiErrorSchema,
        },
      },
    },
    (request) => execute(request, 'openai.settings.verify', () => service.test(readSessionToken(request, config.SESSION_COOKIE_NAME)))
  );
  app.delete(
    '/me/integrations/openai',
    {
      schema: { response: { 204: { type: 'null' }, 401: ApiErrorSchema } },
    },
    async (request, reply) => {
      await execute(request, 'openai.settings.delete', () => service.delete(readSessionToken(request, config.SESSION_COOKIE_NAME)));
      return reply.status(204).send();
    });
}
