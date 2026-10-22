import { streamErrorDiagnostics } from './stream-error-diagnostics.js';
import {
  ApiErrorSchema,
  AppendConversationMessageRequestSchema,
  ConversationMessageSchema,
  ConversationMessagesQuerySchema,
  ConversationMessagesResponseSchema,
  ConversationParamsSchema,
  ConversationThreadSchema,
  ConversationThreadsResponseSchema,
  ConversationTurnResponseSchema,
  RunConversationTurnRequestSchema,
  type AppendConversationMessageRequest,
  type ConversationMessagesQuery,
  type ConversationParams,
  type ConversationTurnResponse,
  type RunConversationTurnRequest,
} from '@movie-hub/contract';
import { AiTrace, currentAiTrace, withAiTrace } from '../../infrastructure/logging/ai-trace.js';
import type { AiLogger } from '../../infrastructure/logging/ai-trace.types.js';
import { LlmProviderError } from '../llm/llm.errors.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppConfig } from '../../config/env.schema.js';
import { AppError } from '../../infrastructure/http/app-error.js';
import { readSessionToken } from '../auth/auth.routes.js';
import type { ConversationService } from './conversation.service.js';
import type { AuthService } from '../auth/auth.service.js';
import type { ConversationTurnService } from './conversation-turn.service.js';
import type { ConversationTurnResult } from './conversation-turn.types.js';
import type { ConversationMessage } from './conversation.types.js';

export function registerConversationRoutes(
  app: FastifyInstance,
  service: ConversationService,
  config: AppConfig,
  turnService?: ConversationTurnService,
  auth?: Pick<AuthService, 'requireOwnerId'>,
  logger?: AiLogger
): void {
  app.get(
    '/conversations',
    {
      schema: { response: { 200: ConversationThreadsResponseSchema, 401: ApiErrorSchema } },
    },
    async (request) => service.listThreads(token(request, config))
  );

  app.post(
    '/conversations',
    {
      schema: { response: { 201: ConversationThreadSchema, 401: ApiErrorSchema } },
    },
    async (request, reply) => {
      return reply.status(201).send(await service.createThread(token(request, config)));
    }
  );

  app.get<{ Params: ConversationParams; Querystring: ConversationMessagesQuery }>(
    '/conversations/:threadId/messages',
    {
      schema: {
        params: ConversationParamsSchema,
        querystring: ConversationMessagesQuerySchema,
        response: { 200: ConversationMessagesResponseSchema, 401: ApiErrorSchema, 404: ApiErrorSchema },
      },
    },
    async (request) => {
      return service.listMessages(token(request, config), request.params.threadId, request.query.limit ?? 50);
    });

  app.post<{ Params: ConversationParams; Body: AppendConversationMessageRequest }>(
    '/conversations/:threadId/messages',
    {
      schema: {
        params: ConversationParamsSchema,
        body: AppendConversationMessageRequestSchema,
        response: { 201: ConversationMessageSchema, 400: ApiErrorSchema, 401: ApiErrorSchema, 404: ApiErrorSchema },
      },
    },
    async (request, reply) => {
      return reply
        .status(201)
        .send(
          await service.appendUserMessage(
            token(request, config),
            request.params.threadId,
            request.body.content,
            request.body.clientRequestId
          )
        );
    });

  if (turnService && auth) {
    app.post<{ Params: ConversationParams; Body: RunConversationTurnRequest }>(
      '/conversations/:threadId/turns',
      {
        schema: {
          params: ConversationParamsSchema,
          body: RunConversationTurnRequestSchema,
          response: {
            201: ConversationTurnResponseSchema,
            400: ApiErrorSchema,
            401: ApiErrorSchema,
            403: ApiErrorSchema,
            429: ApiErrorSchema,
            502: ApiErrorSchema,
            404: ApiErrorSchema,
            503: ApiErrorSchema,
          },
        },
      },
      async (request, reply) => {
        return withAiTrace(
          new AiTrace(
            logger,
            {
              requestId: request.id,
              threadId: request.params.threadId,
              clientRequestId: request.body.clientRequestId,
            },
            request.body.content,
            'conversation.turn',
            config.VERBOSE
          ),
          async () => {
            const trace = currentAiTrace()!;
            trace.event('request.started', { method: request.method, route: request.routeOptions.url });
            const ownerId = await trace.step('authentication', () => auth.requireOwnerId(token(request, config)));
            trace.event('authentication.owner', { ownerId });
            let result;
            try {
              result = await turnService.run({
                ownerId,
                threadId: request.params.threadId,
                content: request.body.content,
                clientRequestId: request.body.clientRequestId,
              }
              );
            } catch (error) {
              trace.fail(error, { ...providerDiagnostics(error) });
              throw error;
            }
            trace.event('request.completed', { ...result.usage });
            return reply.header('x-request-id', request.id).status(201).send(toTurnResponse(result));
          });
      });

    app.post<{ Params: ConversationParams; Body: RunConversationTurnRequest }>(
      '/conversations/:threadId/turns/stream',
      {
        schema: {
          params: ConversationParamsSchema,
          body: RunConversationTurnRequestSchema,
          response: {
            400: ApiErrorSchema,
            401: ApiErrorSchema,
            403: ApiErrorSchema,
            429: ApiErrorSchema,
            502: ApiErrorSchema,
            404: ApiErrorSchema,
            409: ApiErrorSchema,
            503: ApiErrorSchema,
          },
        },
      },
      async (request, reply) => {
        return withAiTrace(
          new AiTrace(
            logger,
            {
              requestId: request.id,
              threadId: request.params.threadId,
              clientRequestId: request.body.clientRequestId,
            },
            request.body.content,
            'conversation.stream',
            config.VERBOSE
          ),
          async () => {
            const trace = currentAiTrace()!;
            trace.event('request.started', { method: request.method, route: request.routeOptions.url });
            const ownerId = await trace.step('authentication', () => auth.requireOwnerId(token(request, config)));
            trace.event('authentication.owner', { ownerId });
            const abortController = new AbortController();
            const onRequestAborted = () => abortController.abort();
            request.raw.once('aborted', onRequestAborted);
            const iterator = turnService
              .stream({
                ownerId,
                threadId: request.params.threadId,
                content: request.body.content,
                clientRequestId: request.body.clientRequestId,
                signal: abortController.signal,
              }
              )[Symbol.asyncIterator]();

            // Pull once before committing SSE headers so validation/auth/not-found errors
            // still use the normal JSON error contract and HTTP status.
            let first: Awaited<ReturnType<typeof iterator.next>>;
            try {
              first = await iterator.next();
            } catch (error) {
              trace.fail(error, { ...providerDiagnostics(error) });
              request.raw.off('aborted', onRequestAborted);
              throw error;
            }
            if (first.done) {
              request.raw.off('aborted', onRequestAborted);
              throw new AppError(503, 'SERVICE_UNAVAILABLE', 'AI stream ended before it started');
            }

            trace.event('sse.started');
            let deltaCount = 0;
            let outputCharacters = 0;
            let streamedText = '';
            let completed = false;
            let failed = false;
            reply.hijack();
            reply.raw.writeHead(200, {
              'content-type': 'text/event-stream; charset=utf-8',
              'cache-control': 'no-cache, no-transform',
              'connection': 'keep-alive',
              'x-accel-buffering': 'no',
              'x-request-id': request.id,
            }
            );
            const onClose = () => {
              if (!reply.raw.writableEnded) abortController.abort();
            };
            reply.raw.on('close', onClose);

            try {
              await writeSse(reply.raw, first.value.type, toStreamPayload(first.value));
              for (;;) {
                const next = await iterator.next();
                if (next.done) break;
                if (next.value.type === 'delta') {
                  deltaCount++;
                  outputCharacters += next.value.delta.length;
                  streamedText += next.value.delta;
                  if (deltaCount === 1) trace.event('sse.first_delta');
                }
                if (next.value.type === 'completed') completed = true;
                await writeSse(reply.raw, next.value.type, toStreamPayload(next.value));
              }
            } catch (error) {
              failed = true;
              if (!abortController.signal.aborted) {
                trace.sensitive(streamedText);
                trace.fail(error, {
                  code: error instanceof AppError ? error.code : 'INTERNAL_ERROR',
                  deltaCount,
                  outputCharacters,
                  ...providerDiagnostics(error),
                  ...streamErrorDiagnostics(error),
                }
                );
              }
              if (!abortController.signal.aborted && !reply.raw.writableEnded) {
                const appError
                  = error instanceof AppError
                    ? error
                    : new AppError(503, 'SERVICE_UNAVAILABLE', 'AI service is temporarily unavailable');
                await writeSse(reply.raw, 'error', {
                  type: 'error',
                  error: { code: appError.code, message: appError.message },
                }
                );
              }
            } finally {
              trace.event(
                abortController.signal.aborted
                  ? 'request.cancelled'
                  : completed && !failed
                    ? 'request.completed'
                    : 'request.failed',
                { deltaCount, outputCharacters }
              );
              reply.raw.off('close', onClose);
              request.raw.off('aborted', onRequestAborted);
              if (!reply.raw.writableEnded) reply.raw.end();
              try {
                await iterator.return?.();
              } catch (error) {
                trace.fail(error, { stage: 'iterator.cleanup' });
                // eslint-disable-next-line no-unsafe-finally -- Preserve observable cleanup failures after the primary stream failure was traced.
                throw error;
              }
            }
            return reply;
          });
      });
  }
}

function token(request: FastifyRequest, config: AppConfig): string | undefined {
  return readSessionToken(request, config.SESSION_COOKIE_NAME);
}

function toTurnResponse(result: ConversationTurnResult): ConversationTurnResponse {
  return {
    userMessage: toMessageResponse(result.userMessage),
    assistantMessage: toMessageResponse(result.assistantMessage),
    usage: result.usage,
  };
}

function toMessageResponse(message: ConversationMessage): ConversationTurnResponse['userMessage'] {
  return {
    id: message.id,
    threadId: message.threadId,
    sequence: message.sequence,
    role: message.role,
    content: message.content,
    createdAt: message.createdAt.toISOString(),
    ...(message.clientRequestId ? { clientRequestId: message.clientRequestId } : {}),
  };
}

function toStreamPayload(event: import('./conversation-turn.types.js').ConversationTurnStreamEvent) {
  if (event.type === 'user_message') {
    return { type: event.type, message: toMessageResponse(event.message) };
  }
  if (event.type === 'completed') {
    return {
      type: event.type,
      assistantMessage: toMessageResponse(event.assistantMessage),
      usage: event.usage,
    };
  }
  return event;
}

async function writeSse(response: import('node:http').ServerResponse, event: string, payload: unknown): Promise<void> {
  if (response.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`)) return;
  await new Promise<void>((resolve, reject) => {
    const onDrain = () => {
      response.off('error', onError);
      resolve();
    };
    const onError = (error: Error) => {
      response.off('drain', onDrain);
      reject(error);
    };
    response.once('drain', onDrain);
    response.once('error', onError);
  });
}

function providerDiagnostics(error: unknown): import('../llm/llm.types.js').LlmFailureDiagnostics | undefined {
  let current = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
    if (current instanceof LlmProviderError) return current.diagnostics;
    current = current.cause;
  }
  return undefined;
}
