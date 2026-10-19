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
  INTEGRATION_SECRET_KEY: 'test-integration-secret-key-at-least-32-characters',
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

test('public config exposes avatar limits from the environment', async () => {
  const app = await buildApp({ config, healthDependencies: [] });
  const response = await app.inject({ method: 'GET', url: '/api/v1/config' });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    notificationTestEnabled: true,
    aiAssistantEnabled: true,
    docsEnabled: false,
    avatar: { maxBytes: config.AVATAR_MAX_BYTES, maxPixels: config.AVATAR_MAX_PIXELS },
  }
  );
  await app.close();
});

test('readiness returns 503 if any dependency is down', async () => {
  const app = await buildApp({
    config,
    healthDependencies: [dependency('mongodb', 'up'), dependency('redis', 'down'), dependency('minio', 'up')],
  }
  );
  const response = await app.inject({ method: 'GET', url: '/api/v1/health/ready' });
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().status, 'degraded');
  await app.close();
});

test('movie routes reject an unsupported locale before calling the service', async () => {
  let called = false;
  const movieService = {
    trending: async () => {
      called = true;
      throw new Error('must not run');
    },
    search: async () => {
      called = true;
      throw new Error('must not run');
    },
    detail: async () => {
      called = true;
      throw new Error('must not run');
    },
    loadMore: async () => {
      called = true;
      throw new Error('must not run');
    },
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

test('experimental page flags gate their APIs and production overrides both flags', async () => {
  for (const mode of ['test', 'development', 'local', 'dev', 'production'] as const) {
    for (const enabled of [false, true]) {
      const app = await buildApp({
        config: { ...config, NODE_ENV: mode, PAGE_AI_ASSISTANT_ENABLED: enabled, PAGE_DOCS_ENABLED: enabled },
        healthDependencies: [],
        authService: {
          requireOwnerId: async () => {
            return 'alice';
          },
        } as unknown as import('./modules/auth/auth.service.js').AuthService,
        conversationService: {
          listThreads: async () => {
            return { items: [] };
          },
        } as unknown as import('./modules/conversations/conversation.service.js').ConversationService,
        docsService: {
          list: async () => {
            return [{ path: 'a.md', title: 'A' }];
          },
          read: async () => {
            return { path: 'a.md', title: 'A', markdown: '# A' };
          },
        } as unknown as import('./modules/docs/docs.service.js').DocsService,
        preferenceService: {
          get: async () => {
            return { version: 1 };
          },
          generate: async () => {
            return { task: { status: 'pending' } };
          },
        } as unknown as import('./modules/preferences/preference.service.js').PreferenceService,
      }
      );
      try {
        const allowed = mode !== 'production' && enabled;
        const publicConfig = (await app.inject('/api/v1/config')).json();
        assert.equal(publicConfig.aiAssistantEnabled, allowed);
        assert.equal(publicConfig.docsEnabled, allowed);
        assert.equal((await app.inject('/api/v1/conversations')).statusCode, allowed ? 200 : 404);
        assert.equal((await app.inject('/api/v1/docs')).statusCode, allowed ? 200 : 404);
        assert.equal((await app.inject('/api/v1/docs/content?path=a.md')).statusCode, allowed ? 200 : 404);
        // The page flag does not disable preference workflows or their generation endpoint.
        assert.equal((await app.inject('/api/v1/me/preferences')).statusCode, 200);
        assert.equal((await app.inject({ method: 'POST', url: '/api/v1/me/preferences/generate' })).statusCode, 202);
      } finally {
        await app.close();
      }
    }
  }
});

test('Docs APIs require authentication before scanning files', async () => {
  let scanned = false;
  const { AppError } = await import('./infrastructure/http/app-error.js');
  const app = await buildApp({
    config: { ...config, PAGE_DOCS_ENABLED: true },
    healthDependencies: [],
    authService: {
      requireOwnerId: async () => {
        throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
      },
    } as unknown as import('./modules/auth/auth.service.js').AuthService,
    docsService: {
      list: async () => {
        scanned = true;
        return [];
      },
    } as unknown as import('./modules/docs/docs.service.js').DocsService,
  }
  );
  try {
    assert.equal((await app.inject('/api/v1/docs')).statusCode, 401);
    assert.equal((await app.inject('/api/v1/docs/content?path=anything.md')).statusCode, 401);
    assert.equal(scanned, false);
  } finally {
    await app.close();
  }
});
