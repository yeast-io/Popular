import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { registerWatchlistRoutes } from './watchlist.routes.js';
import type { WatchlistService } from './watchlist.service.js';
import type { AuthService } from '../auth/auth.service.js';
import type { AppConfig } from '../../config/env.schema.js';
import { AppError } from '../../infrastructure/http/app-error.js';

test('watch list routes require a session, validate categories and propagate owner, locale and diagnostics', async () => {
  const app = Fastify();
  const calls: unknown[][] = [];
  const logs: unknown[] = [];
  app.setErrorHandler((error, request, reply) => reply.status(error instanceof AppError ? error.statusCode : 400).send({ error: { code: error instanceof AppError ? error.code : 'BAD_REQUEST', message: error instanceof Error ? error.message : String(error), requestId: request.id } }));
  const service = {
    list: async (...args: unknown[]) => {
      calls.push(args);
      return { items: [], pagination: { page: 1, pageSize: 20, total: 0, hasMore: false }, locale: args[4] };
    },
    membership: async (...args: unknown[]) => {
      calls.push(args);
      return { inWatchlist: false };
    },
    addTv: async (...args: unknown[]) => {
      calls.push(args);
      return { inWatchlist: true };
    },
    removeTv: async (...args: unknown[]) => {
      calls.push(args);
      return { inWatchlist: false };
    },
  } as unknown as WatchlistService;
  const auth = { requireOwnerId: async (token: string | undefined) => {
    if (token !== 'valid') throw new AppError(401, 'UNAUTHORIZED', 'Unauthorized');
    return 'owner-one';
  } } as unknown as AuthService;
  registerWatchlistRoutes(app, service, auth, { SESSION_COOKIE_NAME: 'sid', TMDB_LANGUAGE: 'zh-CN', VERBOSE: true } as AppConfig, {
    info: (fields: unknown) => { logs.push(fields); },
    error: (fields: unknown) => { logs.push(fields); },
  });
  try {
    for (const method of ['GET', 'PUT', 'DELETE'] as const) {
      const url = method === 'GET' ? '/me/watchlist?mediaType=movie' : '/me/watchlist/tv-shows/42';
      assert.equal((await app.inject({ method, url })).statusCode, 401);
    }
    const headers = { cookie: 'sid=valid' };
    assert.equal((await app.inject({ url: '/me/watchlist?mediaType=tv&locale=en-US', headers })).statusCode, 200);
    assert.deepEqual(calls.shift(), ['owner-one', 'tv', 1, 20, 'en-US']);
    assert.equal((await app.inject({ method: 'PUT', url: '/me/watchlist/tv-shows/42', headers })).statusCode, 200);
    assert.deepEqual(calls.shift(), ['owner-one', 42, 'zh-CN']);
    assert.equal((await app.inject({ method: 'GET', url: '/me/watchlist/tv-shows/42', headers })).json().inWatchlist, false);
    assert.equal((await app.inject({ method: 'DELETE', url: '/me/watchlist/tv-shows/42', headers })).statusCode, 200);
    for (const url of ['/me/watchlist?mediaType=invalid', '/me/watchlist?mediaType=tv&page=0', '/me/watchlist?mediaType=movie&pageSize=51', '/me/watchlist/tv-shows/0']) {
      assert.equal((await app.inject({ url, headers })).statusCode, 400);
    }
    assert.ok(logs.some((value) => typeof (value as { correlationId?: string }).correlationId === 'string'));
  } finally { await app.close(); }
});
