import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import type { TrackedMoviePreference } from '@movie-hub/contract';
import type { AuthService } from '../auth/auth.service.js';
import type { AppConfig } from '../../config/env.schema.js';
import { AppError } from '../../infrastructure/http/app-error.js';
import { registerTvShowRoutes } from '../tv-shows/tv-show.routes.js';
import { registerTvPreferenceRoutes } from './tv-preference.routes.js';
import { TvPreferenceService } from './tv-preference.service.js';

// Exercise authentication, public/private cache boundaries, serialization and persistence together.
test('TV preferences isolate owners, decorate trending/search, toggle/clear and validate requests with correlated diagnostics', async () => {
  const saved = new Map<string, TrackedMoviePreference>();
  const item = { mediaType: 'tv' as const, tmdbId: 42, name: 'Series' };
  const service = new TvPreferenceService({
    list: async (ownerId, preference, page, pageSize) => {
      const ids = [...saved].filter(([key, value]) => key.startsWith(`${ownerId}:`) && value === preference).map(([key]) => Number(key.split(':')[1]));
      return { ids: ids.slice((page - 1) * pageSize, page * pageSize), total: ids.length };
    },
    read: async (ownerId, ids) => ids.flatMap((tmdbId) => {
      const preference = saved.get(`${ownerId}:${tmdbId}`);
      return preference ? [{ tmdbId, preference }] : [];
    }),
    set: async (ownerId, tmdbId, preference) => { saved.set(`${ownerId}:${tmdbId}`, preference); },
    clear: async (ownerId, tmdbId) => { saved.delete(`${ownerId}:${tmdbId}`); },
  }, { readSummaries: async (ids) => ids.includes(42) ? [{ ...item, genreIds: [] }] : [] });
  const publicItems = [item];
  const app = Fastify();
  const logs: unknown[] = [];
  const logger = {
    info: (fields: unknown) => {
      logs.push(fields);
    },
    error: (fields: unknown) => {
      logs.push(fields);
    },
  };
  const auth = {
    optionalOwnerId: async (token?: string) => token ?? null,
    requireOwnerId: async (token?: string) => {
      if (!token) throw new AppError(401, 'UNAUTHORIZED', 'Sign in required');
      return token;
    },
  } as unknown as AuthService;
  const config = { SESSION_COOKIE_NAME: 'sid', TMDB_LANGUAGE: 'zh-CN', VERBOSE: true } as AppConfig;
  app.setErrorHandler((error, request, reply) => {
    reply.status(error instanceof AppError ? error.statusCode : 400).send({ error: { code: error instanceof AppError ? error.code : 'BAD_REQUEST', message: error instanceof Error ? error.message : String(error), requestId: request.id } });
  });
  const search = { search: async () => ({ items: publicItems, page: 1, hasMore: false, stale: false, locale: 'zh-CN' }) };
  const trending = { page: async () => ({ items: publicItems, page: 1, hasMore: false, generation: '00000000-0000-4000-8000-000000000001', fetchedAt: new Date().toISOString(), stale: false, locale: 'zh-CN' }) };
  registerTvShowRoutes(app, search as never, {} as never, trending as never, config, { logger, verbose: true }, auth, service);
  registerTvPreferenceRoutes(app, service, auth, config, logger);
  const url = '/me/tv-shows/42/preference';
  try {
    assert.equal((await app.inject({ method: 'PUT', url, payload: { preference: 'liked' } })).statusCode, 401);
    for (const payload of [{ preference: 'neutral' }, { preference: 'watched' }, {}]) {
      assert.equal((await app.inject({ method: 'PUT', url, headers: { cookie: 'sid=a' }, payload })).statusCode, 400);
    }
    assert.equal((await app.inject({ method: 'PUT', url: '/me/tv-shows/999/preference?locale=zh-CN', headers: { cookie: 'sid=a' }, payload: { preference: 'liked' } })).statusCode, 404);
    assert.equal(saved.size, 0);
    const liked = await app.inject({ method: 'PUT', url, headers: { cookie: 'sid=a' }, payload: { preference: 'liked' } });
    assert.equal(liked.statusCode, 200);
    assert.equal(liked.json().preference, 'liked');
    assert.equal((await app.inject('/me/tv-shows/preferences?preference=liked')).statusCode, 401);
    for (const query of ['preference=watched', 'preference=neutral', 'preference=liked&page=0', 'preference=liked&pageSize=51', 'preference=liked&locale=fr-FR', '']) {
      assert.equal((await app.inject({ url: `/me/tv-shows/preferences?${query}`, headers: { cookie: 'sid=a' } })).statusCode, 400);
    }
    for (const locale of ['en-US', 'zh-CN']) {
      const listing = await app.inject({ url: `/me/tv-shows/preferences?preference=liked&locale=${locale}&pageSize=1`, headers: { cookie: 'sid=a' } });
      assert.equal(listing.statusCode, 200);
      assert.equal(listing.headers['cache-control'], 'private, no-store');
      assert.equal(listing.json().locale, locale);
      assert.deepEqual(listing.json().items, [{ mediaType: 'tv', tmdbId: 42, title: 'Series' }]);
      assert.deepEqual(listing.json().pagination, { page: 1, pageSize: 1, total: 1, hasMore: false });
    }
    assert.deepEqual((await app.inject({ url: '/me/tv-shows/preferences?preference=liked', headers: { cookie: 'sid=b' } })).json().items, []);
    assert.deepEqual((await app.inject({ url: '/me/tv-shows/preferences?preference=liked&page=2&pageSize=1', headers: { cookie: 'sid=a' } })).json().items, []);
    for (const path of ['/tv-shows/trending', '/tv-shows/search?query=Series']) {
      const own = await app.inject({ url: path, headers: { cookie: 'sid=a' } });
      assert.equal(own.json().items[0].userPreference, 'liked');
      assert.equal(own.headers['cache-control'], 'private, no-store');
      assert.equal((await app.inject({ url: path, headers: { cookie: 'sid=b' } })).json().items[0].userPreference, 'neutral');
      assert.equal((await app.inject(path)).json().items[0].userPreference, 'neutral');
    }
    assert.ok(!('userPreference' in item));
    await app.inject({ method: 'PUT', url, headers: { cookie: 'sid=a' }, payload: { preference: 'disliked' } });
    assert.equal(saved.get('a:42'), 'disliked');
    assert.equal((await app.inject({ url: '/me/tv-shows/preferences?preference=liked', headers: { cookie: 'sid=a' } })).json().pagination.total, 0);
    assert.equal((await app.inject({ url: '/me/tv-shows/preferences?preference=disliked', headers: { cookie: 'sid=a' } })).json().items[0].tmdbId, 42);
    assert.equal((await app.inject({ method: 'DELETE', url, headers: { cookie: 'sid=a' } })).json().preference, 'neutral');
    assert.equal(saved.size, 0);
    assert.equal((await app.inject({ method: 'DELETE', url, headers: { cookie: 'sid=a' } })).statusCode, 200);
    assert.ok(logs.some((entry) => typeof (entry as { correlationId?: string }).correlationId === 'string'));
    assert.ok(!JSON.stringify(logs).includes('sid=a'));
  } finally {
    await app.close();
  }
});
