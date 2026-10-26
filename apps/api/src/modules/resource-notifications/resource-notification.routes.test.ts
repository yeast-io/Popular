import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { registerResourceNotificationRoutes } from './resource-notification.routes.js';
import type { ResourceNotificationService } from './resource-notification.service.js';
import type { AuthService } from '../auth/auth.service.js';
import type { AppConfig } from '../../config/env.schema.js';
import { AppError } from '../../infrastructure/http/app-error.js';

test('resource notification routes enforce sessions and schemas, serialize states and trace authenticated owners', async () => {
  const app = Fastify();
  const calls: unknown[][] = [];
  const logs: unknown[] = [];
  app.setErrorHandler((error, request, reply) =>
    reply
      .status(error instanceof AppError ? error.statusCode : 400)
      .send({
        error: {
          code: error instanceof AppError ? error.code : 'BAD_REQUEST',
          message: error instanceof Error ? error.message : 'error',
          requestId: request.id,
        },
      })
  );
  const service = {
    list: async (...args: unknown[]) => {
      calls.push(args);
      return {
        limit: 5,
        locale: args[1],
        items: [
          {
            id: 'entry',
            tmdbId: 1,
            mediaType: 'movie',
            title: 'Movie',
            status: 'notified',
            createdAt: '2026-10-26T00:00:00Z',
            notifiedAt: '2026-10-26T01:00:00Z',
          },
        ],
      };
    },
    membership: async (...args: unknown[]) => {
      calls.push(args);
      return { enabled: true, status: 'notified' };
    },
    add: async (...args: unknown[]) => {
      calls.push(args);
      return { enabled: true, status: 'pending' };
    },
    remove: async (...args: unknown[]) => {
      calls.push(args);
      return { enabled: false };
    },
  } as unknown as ResourceNotificationService;
  const auth = {
    requireOwnerId: async (token?: string) => {
      if (token !== 'valid') throw new AppError(401, 'UNAUTHORIZED', 'Unauthorized');
      return 'session-owner';
    },
  } as unknown as AuthService;
  registerResourceNotificationRoutes(
    app,
    service,
    auth,
    { SESSION_COOKIE_NAME: 'sid', TMDB_LANGUAGE: 'zh-CN', VERBOSE: true } as AppConfig,
    {
      info: (value: unknown) => {
        logs.push(value);
      },
      error: (value: unknown) => {
        logs.push(value);
      },
    }
  );
  try {
    for (const method of ['GET', 'PUT', 'DELETE'] as const)
      assert.equal((await app.inject({ method, url: '/me/resource-notifications/movie/1' })).statusCode, 401);
    const headers = { cookie: 'sid=valid' };
    const list = await app.inject({ url: '/me/resource-notifications?locale=en-US', headers });
    assert.equal(list.statusCode, 200);
    assert.equal(list.json().items[0].status, 'notified');
    assert.deepEqual(calls.shift(), ['session-owner', 'en-US']);
    assert.equal((await app.inject({ url: '/me/resource-notifications/tv/1', headers })).json().status, 'notified');
    assert.deepEqual(calls.shift(), ['session-owner', 'tv', 1]);
    assert.equal(
      (await app.inject({ method: 'PUT', url: '/me/resource-notifications/movie/1?locale=en-US', headers })).json()
        .enabled,
      true
    );
    assert.deepEqual(calls.shift(), ['session-owner', 'movie', 1, 'en-US']);
    assert.equal(
      (await app.inject({ method: 'DELETE', url: '/me/resource-notifications/movie/1', headers })).json().enabled,
      false
    );
    assert.deepEqual(calls.shift(), ['session-owner', 'movie', 1]);
    for (const url of [
      '/me/resource-notifications/other/1',
      '/me/resource-notifications/movie/0',
      '/me/resource-notifications?locale=invalid',
    ])
      assert.equal((await app.inject({ url, headers })).statusCode, 400);
    assert.ok(logs.some((value) => typeof (value as { correlationId?: string }).correlationId === 'string'));
  } finally {
    await app.close();
  }
});
