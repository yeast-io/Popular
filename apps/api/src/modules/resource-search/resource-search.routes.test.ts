import assert from 'node:assert/strict';
import test from 'node:test';
import { buildApp } from '../../app.js';
import { loadConfig } from '../../config/env.js';
import { AppError } from '../../infrastructure/http/app-error.js';
import type { AuthService } from '../auth/auth.service.js';
import { ResourceSearchService } from './resource-search.service.js';
import { ResourceSiteError } from '../resource-sites/resource-site.errors.js';

const config = loadConfig({
  NODE_ENV: 'test',
  WEB_ORIGIN: 'http://localhost:5173',
  MONGODB_URI: 'mongodb://db.example/movie_hub',
  REDIS_URL: 'redis://redis.example:6379',
  MINIO_ENDPOINT: 'minio.example',
  MINIO_ACCESS_KEY: 'access',
  MINIO_SECRET_KEY: 'secret',
  MINIO_BUCKET: 'avatars',
  SESSION_TOKEN_PEPPER: 'test-session-pepper-at-least-32-characters',
  INTEGRATION_SECRET_KEY: 'test-integration-secret-key-at-least-32-characters',
  TMDB_READ_ACCESS_TOKEN: 'test-token',
  ACCESS_LOG_ENABLED: 'false',
});

test('source search endpoints authenticate, isolate failed sources, validate input, and retain source pagination', async () => {
  const calls: Array<{ owner: string; source: string; page: number; mediaType?: string }> = [];
  const auth = {
    requireOwnerId: async (token?: string) => {
      if (!token) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
      return token;
    },
  } as AuthService;
  const service = new ResourceSearchService([
    {
      id: 'mteam',
      name: 'M-Team',
      details: false,
      status: async () => {
        return 'configured_valid';
      },
      search: async (owner, input) => {
        calls.push({ owner, source: 'mteam', page: input.page ?? 1, ...(input.mediaType ? { mediaType: input.mediaType } : {}) });
        return { releases: [{ id: 'same-id', title: 'M-Team Film' }], nextPage: 3 };
      },
    },
    {
      id: 'hdarea',
      name: 'HDArea',
      details: true,
      status: async () => {
        return 'configured_valid';
      },
      search: async (owner, input) => {
        calls.push({ owner, source: 'hdarea', page: input.page ?? 1 });
        throw new ResourceSiteError('timeout');
      },
      detail: async (_owner, id) => ({ id, title: 'HDArea detail' }),
    },
  ]);
  const app = await buildApp({ config, healthDependencies: [], authService: auth, resourceSearchService: service });
  try {
    const base = '/api/v1/me/resource-search';
    assert.equal((await app.inject({ method: 'GET', url: `${base}/sources` })).statusCode, 401);
    assert.equal((await app.inject({ method: 'GET', url: `${base}/mteam/releases?query=Film` })).statusCode, 401);
    assert.equal(calls.length, 0);
    const headers = { cookie: `${config.SESSION_COOKIE_NAME}=owner-A` };
    const list = await app.inject({ method: 'GET', url: `${base}/sources`, headers });
    assert.equal(list.statusCode, 200);
    assert.deepEqual(
      list.json().sources.map((s: { id: string }) => s.id),
      ['mteam', 'hdarea']
    );
    const [success, failure] = await Promise.all([
      app.inject({ method: 'GET', url: `${base}/mteam/releases?query=Film&page=2`, headers }),
      app.inject({ method: 'GET', url: `${base}/hdarea/releases?imdbId=tt0816692`, headers }),
    ]
    );
    assert.equal(success.statusCode, 200);
    assert.equal(success.json().nextPage, 3);
    assert.equal(failure.statusCode, 504);
    assert.equal(failure.json().error.details.reason, 'timeout');
    assert.deepEqual(calls, [
      { owner: 'owner-A', source: 'mteam', page: 2 },
      { owner: 'owner-A', source: 'hdarea', page: 1 },
    ]
    );
    const tv = await app.inject({ method: 'GET', url: `${base}/mteam/releases?query=MobLand%20S01&mediaType=tv`, headers });
    assert.equal(tv.statusCode, 200);
    assert.equal(calls.at(-1)?.mediaType, 'tv');
    assert.equal((await app.inject({ method: 'GET', url: `${base}/mteam/releases?query=Film&mediaType=invalid`, headers })).statusCode, 400);
    assert.equal(
      (await app.inject({ method: 'GET', url: `${base}/unknown/releases?query=Film`, headers })).statusCode,
      404
    );
    assert.equal(
      (await app.inject({ method: 'GET', url: `${base}/mteam/releases?query=%20`, headers })).statusCode,
      400
    );
    const detail = await app.inject({ method: 'GET', url: `${base}/hdarea/releases/42`, headers });
    assert.equal(detail.statusCode, 200);
    assert.equal(detail.json().title, 'HDArea detail');
  } finally {
    await app.close();
  }
});
