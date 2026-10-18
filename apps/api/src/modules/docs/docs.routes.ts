import type { FastifyInstance } from 'fastify';
import { DocsDocumentSchema, DocsIndexSchema } from '@movie-hub/contract';
import type { AuthService } from '../auth/auth.service.js';
import type { AppConfig } from '../../config/env.js';
import { readSessionToken } from '../auth/auth.routes.js';
import { AiTrace, withAiTrace, type AiLogger } from '../../infrastructure/logging/ai-trace.js';
import type { DocsService } from './docs.service.js';

export function registerDocsRoutes(app: FastifyInstance, service: DocsService, auth: Pick<AuthService, 'requireOwnerId'>, config: AppConfig, logger: AiLogger) {
  app.get('/docs', { schema: { response: { 200: DocsIndexSchema } } }, (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const trace = new AiTrace(logger, { requestId: request.id }, '', 'docs.list', config.VERBOSE);
    return withAiTrace(trace, async () => {
      try {
        await trace.step('docs.authentication', () => auth.requireOwnerId(readSessionToken(request, config.SESSION_COOKIE_NAME)));
        return { items: await service.list() };
      } catch (error) { trace.fail(error); throw error; }
    });
  });
  app.get<{ Querystring: { path: string } }>('/docs/content', {
    schema: { querystring: { type: 'object', required: ['path'], additionalProperties: false, properties: { path: { type: 'string', minLength: 1, maxLength: 1024 } } }, response: { 200: DocsDocumentSchema } },
  }, (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const trace = new AiTrace(logger, { requestId: request.id }, '', 'docs.read', config.VERBOSE);
    return withAiTrace(trace, async () => {
      try {
        await trace.step('docs.authentication', () => auth.requireOwnerId(readSessionToken(request, config.SESSION_COOKIE_NAME)));
        return await service.read(request.query.path);
      } catch (error) { trace.fail(error); throw error; }
    });
  });
}
