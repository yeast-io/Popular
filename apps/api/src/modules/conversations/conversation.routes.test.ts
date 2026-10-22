import assert from 'node:assert/strict';
import test from 'node:test';
import { buildApp } from '../../app.js';
import { loadConfig } from '../../config/env.js';
import type { ConversationService } from './conversation.service.js';
import type { AuthService } from '../auth/auth.service.js';
import type { ConversationTurnService } from './conversation-turn.service.js';

const config = loadConfig({
  WEB_ORIGIN: 'http://localhost:5173',
  MONGODB_URI: 'mongodb://db.example/movie_hub',
  REDIS_URL: 'redis://redis.example:6379',
  MINIO_ENDPOINT: 'minio.example',
  MINIO_ACCESS_KEY: 'access',
  MINIO_SECRET_KEY: 'secret',
  MINIO_BUCKET: 'avatars',
  SESSION_TOKEN_PEPPER: 'test-session-pepper-at-least-32-characters',
  INTEGRATION_SECRET_KEY: 'test-integration-secret-key-at-least-32-characters',
  TMDB_READ_ACCESS_TOKEN: 'tmdb-token',
});

const threadId = '507f1f77bcf86cd799439011';
const messageId = '507f1f77bcf86cd799439012';
const createdAt = '2026-01-01T00:00:00.000Z';

test('conversation routes pass the session token and expose only user message creation', async () => {
  const calls: Array<{ token?: string; content?: string }> = [];
  const service = {
    createThread: async (token: string | undefined) => {
      calls.push({ ...(token ? { token } : {}) });
      return { id: threadId, status: 'active' as const, nextSequence: 1, createdAt, updatedAt: createdAt };
    },
    listThreads: async () => {
      return {
        items: [
          {
            id: threadId,
            title: 'First chat',
            status: 'active' as const,
            nextSequence: 1,
            createdAt,
            updatedAt: createdAt,
          },
        ],
      };
    },
    listMessages: async () => ({ items: [] }),
    appendUserMessage: async (
      token: string | undefined,
      inputThreadId: string,
      content: string,
      clientRequestId?: string
    ) => {
      calls.push({ ...(token ? { token } : {}), content });
      return {
        id: messageId,
        threadId: inputThreadId,
        sequence: 1,
        role: 'user' as const,
        content,
        createdAt,
        ...(clientRequestId ? { clientRequestId } : {}),
      };
    },
  } as unknown as ConversationService;
  const app = await buildApp({ config, healthDependencies: [], conversationService: service });

  const create = await app.inject({
    method: 'POST',
    url: '/api/v1/conversations',
    headers: { cookie: 'movie_hub_session=session-1' },
  }
  );
  assert.equal(create.statusCode, 201);
  assert.equal(calls[0]?.token, 'session-1');

  const list = await app.inject({
    method: 'GET',
    url: '/api/v1/conversations',
    headers: { cookie: 'movie_hub_session=session-1' },
  }
  );
  assert.equal(list.statusCode, 200);
  assert.equal(list.json().items[0].title, 'First chat');

  const append = await app.inject({
    method: 'POST',
    url: `/api/v1/conversations/${threadId}/messages`,
    headers: { cookie: 'movie_hub_session=session-1' },
    payload: { content: 'hello', clientRequestId: 'request-1' },
  }
  );
  assert.equal(append.statusCode, 201);
  assert.equal(append.json().role, 'user');

  const forged = await app.inject({
    method: 'POST',
    url: `/api/v1/conversations/${threadId}/messages`,
    payload: { role: 'assistant', content: 'forged' },
  }
  );
  assert.equal(forged.statusCode, 201);
  assert.equal(forged.json().role, 'user');
  await app.close();
});

test('turn route requires an idempotency key and returns persisted turn messages', async () => {
  const calls: Array<{ ownerId: string; threadId: string; content: string; clientRequestId: string }> = [];
  const auth = {
    requireOwnerId: async (token: string | undefined) => {
      assert.equal(token, 'session-1');
      return 'owner-1';
    },
  } as unknown as AuthService;
  const turnService = {
    run: async (input: { ownerId: string; threadId: string; content: string; clientRequestId: string }) => {
      calls.push(input);
      return {
        userMessage: {
          id: messageId,
          ownerId: input.ownerId,
          threadId: input.threadId,
          sequence: 1,
          role: 'user' as const,
          content: input.content,
          clientRequestId: input.clientRequestId,
          createdAt: new Date(createdAt),
        },
        assistantMessage: {
          id: '507f1f77bcf86cd799439013',
          ownerId: input.ownerId,
          threadId: input.threadId,
          sequence: 2,
          role: 'assistant' as const,
          content: 'A response',
          createdAt: new Date(createdAt),
        },
        usage: { inputTokens: 12, outputTokens: 3 },
      };
    },
    stream: async function* (input: { ownerId: string; threadId: string; content: string; clientRequestId: string }) {
      calls.push(input);
      yield {
        type: 'user_message' as const,
        message: {
          id: messageId,
          ownerId: input.ownerId,
          threadId: input.threadId,
          sequence: 1,
          role: 'user' as const,
          content: input.content,
          clientRequestId: input.clientRequestId,
          createdAt: new Date(createdAt),
        },
      };
      yield { type: 'delta' as const, delta: 'A ' };
      yield { type: 'delta' as const, delta: 'response' };
      yield {
        type: 'completed' as const,
        assistantMessage: {
          id: '507f1f77bcf86cd799439013',
          ownerId: input.ownerId,
          threadId: input.threadId,
          sequence: 2,
          role: 'assistant' as const,
          content: 'A response',
          createdAt: new Date(createdAt),
        },
        usage: { inputTokens: 12, outputTokens: 3 },
      };
    },
  } as unknown as ConversationTurnService;
  const conversationService = {
    createThread: async () => {
      return { id: threadId, status: 'active', nextSequence: 1, createdAt, updatedAt: createdAt };
    },
    listThreads: async () => ({ items: [] }),
    listMessages: async () => ({ items: [] }),
    appendUserMessage: async () => {
      throw new Error('not used');
    },
  } as unknown as ConversationService;
  const app = await buildApp({
    config,
    healthDependencies: [],
    authService: auth,
    conversationService,
    conversationTurnService: turnService,
  }
  );

  const missingKey = await app.inject({
    method: 'POST',
    url: `/api/v1/conversations/${threadId}/turns`,
    headers: { cookie: 'movie_hub_session=session-1' },
    payload: { content: 'hello' },
  }
  );
  assert.equal(missingKey.statusCode, 400);

  const response = await app.inject({
    method: 'POST',
    url: `/api/v1/conversations/${threadId}/turns`,
    headers: { cookie: 'movie_hub_session=session-1' },
    payload: { content: 'hello', clientRequestId: 'turn-1' },
  }
  );
  assert.equal(response.statusCode, 201);
  assert.equal(response.json().assistantMessage.content, 'A response');
  assert.deepEqual(response.json().usage, { inputTokens: 12, outputTokens: 3 });
  assert.deepEqual(calls, [
    {
      ownerId: 'owner-1',
      threadId,
      content: 'hello',
      clientRequestId: 'turn-1',
    },
  ]);

  const streamed = await app.inject({
    method: 'POST',
    url: `/api/v1/conversations/${threadId}/turns/stream`,
    headers: { cookie: 'movie_hub_session=session-1' },
    payload: { content: 'stream hello', clientRequestId: 'turn-stream-1' },
  }
  );
  assert.equal(streamed.statusCode, 200);
  assert.match(streamed.headers['content-type'] ?? '', /^text\/event-stream/);
  assert.match(streamed.body, /event: user_message/);
  assert.match(streamed.body, /event: delta\ndata: \{"type":"delta","delta":"A "\}/);
  assert.match(streamed.body, /event: completed/);
  await app.close();
});

test('logs safe diagnostics after SSE starts while keeping client errors generic', async () => {
  const { default: Fastify } = await import('fastify');
  const { registerConversationRoutes } = await import('./conversation.routes.js');
  const { LlmProviderError } = await import('../llm/llm.errors.js');
  const { AppError } = await import('../../infrastructure/http/app-error.js');
  const logs: unknown[] = [];
  const app = Fastify();
  const turnService = {
    stream: async function* () {
      yield { type: 'delta', delta: 'private chat text' };
      throw new AppError(503, 'SERVICE_UNAVAILABLE', 'AI service is temporarily unavailable', undefined, {
        cause: new LlmProviderError('Upstream failure: sk-private', undefined, {
          reason: 'terminal_failure',
          lastEventType: 'response.incomplete',
          incompleteReason: 'max_output_tokens',
        }),
      });
    },
  } as unknown as ConversationTurnService;
  registerConversationRoutes(
    app,
    {} as ConversationService,
    config,
    turnService,
    { requireOwnerId: async () => 'owner-1' },
    {
      error: ((...args: unknown[]) => {
        logs.push(args);
      }) as never,
    }
  );
  try {
    const response = await app.inject({
      method: 'POST',
      url: `/conversations/${threadId}/turns/stream`,
      payload: { content: 'private prompt', clientRequestId: 'request-1' },
    }
    );
    assert.equal(response.statusCode, 200);
    assert.match(response.body, /event: error/);
    assert.ok(!response.body.includes('max_output_tokens'));
    assert.equal(logs.length, 1);
    const bindings = (logs[0] as unknown[])[0] as Record<string, unknown>;
    assert.equal(bindings.operation, 'conversation.stream');
    assert.equal(typeof bindings.requestId, 'string');
    assert.equal(bindings.incompleteReason, 'max_output_tokens');
    assert.ok(!JSON.stringify(logs).includes('private chat text'));
    assert.ok(!JSON.stringify(logs).includes('sk-private'));
    assert.match(JSON.stringify(logs), /Upstream failure/);
    assert.match(JSON.stringify(logs), /stack/);
  } finally {
    await app.close();
  }
});
