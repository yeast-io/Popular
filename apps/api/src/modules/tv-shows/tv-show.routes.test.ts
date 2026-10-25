import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import type { AppConfig } from '../../config/env.schema.js';
import { registerTvShowRoutes } from './tv-show.routes.js';
import { TvShowService } from './tv-show.service.js';
import { TvSeasonService } from './tv-season.service.js';
import type { TvShowRecord, TvShowCatalogStore, TvShowProvider } from './tv-show.types.js';
import { AppError } from '../../infrastructure/http/app-error.js';

const show: TvShowRecord = { mediaType: 'tv', tmdbId: 42, name: 'Series', genreIds: [], seasons: [], syncedAt: new Date() };
test('TV routes validate inputs, retain locale/default locale, serialize media type and trace correlation', async () => {
  const app = Fastify();
  const logs: unknown[] = [];
  app.setErrorHandler((error, _request, reply) => reply.status(error instanceof AppError ? error.statusCode : 400).send({ error: { message: error instanceof Error ? error.message : String(error) } }));
  const lock = { acquire: async () => 'owner', release: async () => {
  } };
  const catalog: TvShowCatalogStore = { readDetail: async () => show, writeDetail: async () => {
  }, readSummaries: async () => [], upsertSummaries: async () => {
  } };
  const provider: TvShowProvider = { search: async (_query, page) => ({ items: [show], page, totalPages: 3, totalResults: 50 }), fetchDetail: async () => show, fetchTrending: async (page) => ({ items: [show], page, totalPages: 1, totalResults: 1 }) };
  const seasons = { readDetail: async () => null, readSummaries: async () => [], writeDetail: async () => {
  }, writeSummaries: async () => {
  } };
  registerTvShowRoutes(app, new TvShowService(catalog, provider, lock), new TvSeasonService(seasons, { fetchSeason: async (tmdbId, seasonNumber) => ({ tmdbId: 1, tvShowTmdbId: tmdbId, seasonNumber, name: 'Season', episodes: [] }) }, lock), { page: async () => ({ items: [show], page: 1, totalPages: 1, totalResults: 1, generation: '00000000-0000-4000-8000-000000000001', fetchedAt: new Date().toISOString(), hasMore: false }) }, { TMDB_LANGUAGE: 'zh-CN', SESSION_COOKIE_NAME: 'sid' } as AppConfig, { verbose: true, logger: { info: (fields: unknown) => {
    logs.push(fields);
  }, error: (fields: unknown) => {
    logs.push(fields);
  } } });
  try {
    const trending = await app.inject('/tv-shows/trending?locale=en-US');
    assert.equal(trending.statusCode, 200);
    assert.equal(trending.json().locale, 'en-US');
    assert.equal(trending.json().stale, false);
    assert.equal(trending.json().items[0]?.mediaType, 'tv');
    assert.equal(trending.headers['cache-control'], 'private, no-store');
    const search = await app.inject('/tv-shows/search?query=Series&page=2&locale=en-US');
    assert.equal(search.statusCode, 200);
    assert.equal(search.json().page, 2);
    assert.equal(search.json().locale, 'en-US');
    assert.equal(search.json().items[0]?.mediaType, 'tv');
    const result = await app.inject('/tv-shows/42?locale=en-US');
    assert.equal(result.statusCode, 200);
    assert.equal(result.json().locale, 'en-US');
    assert.equal(result.json().mediaType, 'tv');
    assert.equal((await app.inject('/tv-shows/42')).json().locale, 'zh-CN');
    assert.equal((await app.inject('/tv-shows/42/seasons/0?locale=en-US')).statusCode, 200);
    for (const url of ['/tv-shows/search?query=%20%20', '/tv-shows/search?query=ok&page=51', '/tv-shows/search?query=' + 'a'.repeat(101), '/tv-shows/0', '/tv-shows/42?locale=fr-FR', '/tv-shows/42/seasons/-1', '/tv-shows/trending?page=51', '/tv-shows/trending?generation=bad']) {
      assert.equal((await app.inject(url)).statusCode, 400, url);
    }
    assert.ok(logs.some((value) => typeof (value as {
      correlationId?: string;
    }).correlationId === 'string'));
  } finally {
    await app.close();
  }
});
