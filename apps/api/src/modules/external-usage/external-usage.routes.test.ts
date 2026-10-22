import assert from 'node:assert/strict';
import test from 'node:test';
import { buildApp } from '../../app.js';
import { loadConfig } from '../../config/env.js';
import { AppError } from '../../infrastructure/http/app-error.js';
import { ExternalUsageService } from './external-usage.service.js';

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

test('external usage route requires its owner and validates the requested range', async () => {
  const service = new ExternalUsageService(
    {
      requireOwnerId: async (token) => {
        if (token !== 'valid-session') throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
        return '507f1f77bcf86cd799439011';
      },
    },
    {
      readUserUsage: async () => {
        return {
          totals: { requests: 0, successes: 0, failures: 0, totalDurationMs: 0 },
          providers: [],
          daily: [],
          operations: [],
        };
      },
    },
    () => new Date('2026-10-13T22:30:00.000Z')
  );
  const app = await buildApp({ config, healthDependencies: [], externalUsageService: service });

  const unauthorized = await app.inject({ method: 'GET', url: '/api/v1/me/external-usage?days=7' });
  assert.equal(unauthorized.statusCode, 401);

  const invalid = await app.inject({
    method: 'GET',
    url: '/api/v1/me/external-usage?days=14',
    headers: { cookie: `${config.SESSION_COOKIE_NAME}=valid-session` },
  }
  );
  assert.equal(invalid.statusCode, 400);

  const response = await app.inject({
    method: 'GET',
    url: '/api/v1/me/external-usage?days=7',
    headers: { cookie: `${config.SESSION_COOKIE_NAME}=valid-session` },
  }
  );
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().range, {
    days: 7,
    from: '2026-10-07',
    to: '2026-10-13',
    timezone: 'UTC',
    retentionDays: 90,
  }
  );
  assert.equal(response.json().daily.length, 7);

  await app.close();
});

test('HTTP response preserves provider token metrics and model details', async () => {
  const tokenUsage = {
    inputTokens: 20,
    outputTokens: 5,
    cachedInputTokens: 10,
    knownRequests: 1,
    unknownRequests: 0,
    unknownCachedRequests: 0,
  };
  const metric = { requests: 1, successes: 1, failures: 0, totalDurationMs: 100, tokenUsage };
  const service = new ExternalUsageService(
    {
      requireOwnerId: async () => {
        return '507f1f77bcf86cd799439011';
      },
    },
    {
      readUserUsage: async () => {
        return {
          totals: metric,
          providers: [{ provider: 'openai', ...metric }],
          daily: [],
          operations: [{ provider: 'openai', operation: 'conversation.summary', ...metric }],
          models: [{ provider: 'openai', model: 'test-model', operation: 'conversation.summary', ...metric }],
        };
      },
    }
  );
  const app = await buildApp({ config, healthDependencies: [], externalUsageService: service });
  try {
    const response = await app.inject({ method: 'GET', url: '/api/v1/me/external-usage' });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().providers[0].tokenUsage, tokenUsage);
    assert.equal(response.json().models[0].model, 'test-model');
    assert.equal(response.json().models[0].operation, 'conversation.summary');
  } finally {
    await app.close();
  }
});
