import assert from 'node:assert/strict';
import test from 'node:test';
import { buildApp } from './app.js';
import { loadConfig } from './config/env.js';
import type { HealthDependency } from './infrastructure/health/dependency.js';
import type { MovieService } from './modules/movies/movie.service.js';

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
  TMDB_READ_ACCESS_TOKEN: 'test-token',
  ACCESS_LOG_ENABLED: 'false',
});

function dependency(name: HealthDependency['name'], status: 'up' | 'down'): HealthDependency {
  return { name, check: async () => ({ status, latencyMs: 1 }), close: async () => undefined };
}

test('liveness does not depend on external services', async () => {
  const app = await buildApp({ config, healthDependencies: [] });
  const response = await app.inject({ method: 'GET', url: '/api/v1/health/live' });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().status, 'ok');
  await app.close();
});

test('readiness returns 503 if any dependency is down', async () => {
  const app = await buildApp({ config, healthDependencies: [
    dependency('mongodb', 'up'), dependency('redis', 'down'), dependency('minio', 'up'),
  ] });
  const response = await app.inject({ method: 'GET', url: '/api/v1/health/ready' });
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().status, 'degraded');
  await app.close();
});

test('movie routes reject an unsupported locale before calling the service', async () => {
  let called = false;
  const movieService = {
    trending: async () => { called = true; throw new Error('must not run'); },
    search: async () => { called = true; throw new Error('must not run'); },
    detail: async () => { called = true; throw new Error('must not run'); },
    loadMore: async () => { called = true; throw new Error('must not run'); },
  } as unknown as MovieService;
  const app = await buildApp({ config, healthDependencies: [], movieService });

  for (const url of [
    '/api/v1/movies/trending?locale=fr-FR',
    '/api/v1/movies/search?query=movie&locale=fr-FR',
    '/api/v1/movies/1?locale=fr-FR',
  ]) {
    const response = await app.inject({ method: 'GET', url });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.code, 'VALIDATION_ERROR');
  }
  assert.equal(called, false);
  await app.close();
});
