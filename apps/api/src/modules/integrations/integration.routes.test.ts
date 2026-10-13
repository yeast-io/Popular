import assert from 'node:assert/strict';
import test from 'node:test';
import { buildApp } from '../../app.js';
import { loadConfig } from '../../config/env.js';
import type { AuthService } from '../auth/auth.service.js';
import { IntegrationService } from './integration.service.js';
import type { IntegrationConfigRecord, IntegrationConfigStore, MTeamVerifier } from './integration.types.js';
import { SecretCrypto } from './secret-crypto.js';
import { AppError } from '../../infrastructure/http/app-error.js';

const config = loadConfig({
  NODE_ENV: 'test', WEB_ORIGIN: 'http://localhost:5173', MONGODB_URI: 'mongodb://db.example/movie_hub',
  REDIS_URL: 'redis://redis.example:6379', MINIO_ENDPOINT: 'minio.example', MINIO_ACCESS_KEY: 'access',
  MINIO_SECRET_KEY: 'secret', MINIO_BUCKET: 'avatars', SESSION_TOKEN_PEPPER: 'test-session-pepper-at-least-32-characters',
  INTEGRATION_SECRET_KEY: 'test-integration-secret-key-at-least-32-characters',
  TMDB_READ_ACCESS_TOKEN: 'test-token', ACCESS_LOG_ENABLED: 'false',
});

test('M-Team routes require authentication and never serialize the API key', async () => {
  let record: IntegrationConfigRecord | null = null;
  const store: IntegrationConfigStore = {
    async find() { return record; },
    async saveVerified(input) { record = input; return input; },
    async recordFailure() {},
    async delete() { record = null; },
  };
  const auth = {
    requireOwnerId: async (token: string | undefined) => {
      if (token !== 'valid-session') throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
      return '507f1f77bcf86cd799439011';
    },
  } as unknown as AuthService;
  const verifier: MTeamVerifier = {
    async verify(_baseUrl, apiKey) {
      if (apiKey === 'must-not-leak-on-failure') {
        throw new Error(`upstream rejected credential ${apiKey}`);
      }
    },
  };
  const service = new IntegrationService(
    auth, store, verifier, new SecretCrypto('test-integration-secret-key-that-is-long-enough'),
    new Set(['api.m-team.cc']), () => new Date('2026-10-12T05:00:00.000Z'),
  );
  const app = await buildApp({ config, healthDependencies: [], integrationService: service });

  const unauthorized = await app.inject({ method: 'GET', url: '/api/v1/me/integrations/mteam' });
  assert.equal(unauthorized.statusCode, 401);

  const saved = await app.inject({
    method: 'PUT', url: '/api/v1/me/integrations/mteam',
    headers: { cookie: `${config.SESSION_COOKIE_NAME}=valid-session` },
    payload: { baseUrl: 'https://api.m-team.cc/', apiKey: 'must-not-leak' },
  });
  assert.equal(saved.statusCode, 200);
  assert.equal(saved.json().baseUrl, 'https://api.m-team.cc');
  assert.equal(JSON.stringify(saved.json()).includes('must-not-leak'), false);
  assert.equal('apiKey' in saved.json(), false);

  const failed = await app.inject({
    method: 'PUT', url: '/api/v1/me/integrations/mteam',
    headers: { cookie: `${config.SESSION_COOKIE_NAME}=valid-session` },
    payload: { baseUrl: 'https://api.m-team.cc/', apiKey: 'must-not-leak-on-failure' },
  });
  assert.equal(failed.statusCode, 503);
  assert.equal(failed.json().error.code, 'MTEAM_UNREACHABLE');
  assert.equal(failed.body.includes('must-not-leak-on-failure'), false);

  await app.close();
});
