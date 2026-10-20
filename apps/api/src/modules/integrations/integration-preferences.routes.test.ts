import assert from 'node:assert/strict';
import test from 'node:test';
import { buildApp } from '../../app.js';
import { loadConfig } from '../../config/env.js';
import { AppError } from '../../infrastructure/http/app-error.js';
import type { AuthService } from '../auth/auth.service.js';
import type { MovieStatusService } from '../movie-statuses/movie-status.service.js';
import type { IntegrationPreferencesService } from './integration-preferences.service.js';
import type { MovieSiteResourcesService } from './movie-site-resources.service.js';

const config = loadConfig({ NODE_ENV: 'test', WEB_ORIGIN: 'http://localhost:5173', MONGODB_URI: 'mongodb://db.example/movie_hub', REDIS_URL: 'redis://redis.example:6379', MINIO_ENDPOINT: 'minio.example', MINIO_ACCESS_KEY: 'access', MINIO_SECRET_KEY: 'secret', MINIO_BUCKET: 'avatars', SESSION_TOKEN_PEPPER: 'test-session-pepper-at-least-32-characters', INTEGRATION_SECRET_KEY: 'test-integration-secret-key-at-least-32-characters', TMDB_READ_ACCESS_TOKEN: 'test-token', ACCESS_LOG_ENABLED: 'false' });
test('preference and generic resource routes authenticate, retain multi-site responses, and validate selections', async () => {
  const owners: string[] = [];
  const releaseCalls: Array<{ owner: string; tmdbId: number; site: string; page: number; force: boolean }> = [];
  const auth = { async requireOwnerId(token?: string) { if (!token) throw new AppError(401, 'UNAUTHORIZED', ''); return token; } } as AuthService;
  const state = { defaults: { resource: 'mteam' }, selectedSites: ['mteam', 'hdarea'], effectiveSites: ['mteam', 'hdarea'], choices: [] };
  const preferences = {
    async get(owner: string) { owners.push(owner); return state; },
    async selectSites(owner: string) { owners.push(owner); return state; },
    async setDefault(owner: string) { owners.push(owner); return state; },
  } as unknown as IntegrationPreferencesService;
  const resources = {
    async summary(owner: string) { owners.push(owner); return { provider: 'all', availability: 'available', checking: false, incomplete: true, sources: [
      { provider: 'mteam', availability: 'available', checking: false },
      { provider: 'hdarea', availability: 'unchecked', checking: false, lastAttemptStatus: 'error', lastErrorCode: 'RESOURCE_SITE_FAILED' },
    ] }; },
    async listReleases(owner: string, tmdbId: number, site: string, page = 1, force = false) { owners.push(owner); releaseCalls.push({ owner, tmdbId, site, page, force }); return { site, name: site, supportsDownload: site === 'mteam', availability: 'available', queriedAt: new Date().toISOString(), cached: false, releases: [{ id: '42', title: 'Film', detailsUrl: 'https://example.test/details/42', seeders: 0, seedersKnown: false, tags: [] }] }; },
  } as unknown as MovieSiteResourcesService;
  const app = await buildApp({ config, healthDependencies: [], authService: auth, integrationPreferencesService: preferences, movieSiteResourcesService: resources,
    movieStatusService: {} as MovieStatusService }
  );
  try {
    const base = '/api/v1/me';
    assert.equal((await app.inject({ method: 'GET', url: `${base}/integration-preferences` })).statusCode, 401);
    assert.equal(
      (await app.inject({ method: 'GET', url: `${base}/movies/603/resources/hdarea/releases` })).statusCode, 401
    );
    assert.equal(
      (await app.inject({ method: 'POST', url: `${base}/movies/603/resources/hdarea/releases/refresh` })).statusCode,
      401
    );
    assert.deepEqual(owners, []);
    const headers = { cookie: `${config.SESSION_COOKIE_NAME}=alice` };
    const summary = await app.inject({ method: 'GET', url: `${base}/movies/603/resources`, headers });
    assert.equal(summary.statusCode, 200);
    assert.equal(summary.json().sources.length, 2);
    assert.equal(summary.json().incomplete, true);
    for (const site of ['mteam', 'hdarea']) {
      const response = await app.inject(
        { method: 'GET', url: `${base}/movies/603/resources/${site}/releases`, headers }
      );
      assert.equal(response.statusCode, 200);
      assert.equal(response.json().site, site);
      assert.equal(response.json().releases[0].seedersKnown, false);
    }
    assert.equal(
      (await app.inject(
        { method: 'PUT', url: `${base}/integration-preferences/resource-sites`, headers, payload: { sites: ['mteam', 'mteam'] } }
      )).statusCode,
      400
    );
    assert.equal(
      (await app.inject(
        { method: 'PUT', url: `${base}/integration-preferences/default`, headers, payload: { category: 'other', id: 'mteam' } }
      )).statusCode,
      400
    );
    assert.equal(
      (await app.inject(
        { method: 'PUT', url: `${base}/integration-preferences/resource-sites`, headers, payload: { sites: [] } }
      )).statusCode,
      200
    );
    const refreshed = await app.inject(
      { method: 'POST', url: `${base}/movies/603/resources/hdarea/releases/refresh`, headers }
    );
    assert.equal(refreshed.statusCode, 200);
    assert.equal(refreshed.json().site, 'hdarea');
    assert.deepEqual(releaseCalls.at(-1), { owner: 'alice', tmdbId: 603, site: 'hdarea', page: 1, force: true });
    assert.equal(releaseCalls.filter((call) => call.force).length, 1);
    assert.ok(owners.every((owner) => owner === 'alice'));
  } finally { await app.close(); }
});
