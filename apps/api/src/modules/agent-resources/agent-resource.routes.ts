import type { FastifyInstance } from 'fastify';
import { AgentResourceModeSchema, AgentResourceModeResponseSchema, ApiErrorSchema } from '@movie-hub/contract';
import type { AgentResourceMode } from '@movie-hub/contract';
import type { AgentResourceService } from './agent-resource.service.js';
import type { AuthService } from '../auth/auth.service.js';
import { readSessionToken } from '../auth/auth.routes.js';
import type { AppConfig } from '../../config/env.schema.js';
import type { AiLogger } from '../../infrastructure/logging/ai-trace.types.js';
import { aiStep, AiTrace, withAiTrace } from '../../infrastructure/logging/ai-trace.js';
import { ResourceSiteError } from '../resource-sites/resource-site.errors.js';
import { resourceSiteMessages } from '../resource-sites/resource-site.messages.js';

export function registerAgentResourceRoutes(
  app: FastifyInstance,
  service: AgentResourceService,
  auth: AuthService,
  config: AppConfig,
  logger: AiLogger
): void {
  const response = {
    200: AgentResourceModeResponseSchema,
    400: ApiErrorSchema,
    401: ApiErrorSchema,
    409: ApiErrorSchema,
    502: ApiErrorSchema,
    503: ApiErrorSchema,
    504: ApiErrorSchema,
  };
  const run = (request: import('fastify').FastifyRequest, action: (owner: string) => Promise<unknown>) => {
    const trace = new AiTrace(logger, { requestId: request.id }, '', 'agent-resource.mode', config.VERBOSE);
    return withAiTrace(trace, async () => {
      try {
        const owner = await aiStep('agent-resource.mode.authenticate', () =>
          auth.requireOwnerId(readSessionToken(request, config.SESSION_COOKIE_NAME))
        );
        return await action(owner);
      } catch (error) {
        trace.fail(error);
        if (error instanceof ResourceSiteError)
          error.message
            = resourceSiteMessages[request.headers['accept-language']?.startsWith('zh') ? 'zh' : 'en'][error.reason];
        throw error;
      }
    });
  };
  app.get('/me/resource-execution', { schema: { response } }, (request) =>
    run(request, (owner) => service.mode(owner))
  );
  app.put<{ Body: AgentResourceMode }>(
    '/me/resource-execution',
    { schema: { body: AgentResourceModeSchema, response } },
    (request) => run(request, (owner) => service.setMode(owner, request.body.deviceId))
  );
}
