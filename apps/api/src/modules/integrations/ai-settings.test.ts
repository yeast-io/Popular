import assert from 'node:assert/strict';
import test from 'node:test';
import type { AiProvider } from '@movie-hub/contract';
import type { AiConfigRecord, AiConfigStore, AiSettingsRegistry } from './ai-settings.types.js';
import { AiSettingsService } from './ai-settings.service.js';
import { SecretCrypto } from './secret-crypto.js';
import { AI_PROVIDERS, AI_MODEL_LIMITS } from './ai-provider.policy.js';
import { buildApp } from '../../app.js';
import { loadConfig } from '../../config/env.js';

const config = loadConfig({
  WEB_ORIGIN: 'http://localhost:5173', MONGODB_URI: 'mongodb://db.example/movie_hub',
  REDIS_URL: 'redis://redis.example:6379', MINIO_ENDPOINT: 'minio.example', MINIO_ACCESS_KEY: 'access',
  MINIO_SECRET_KEY: 'secret', MINIO_BUCKET: 'avatars', SESSION_TOKEN_PEPPER: 'test-session-pepper-at-least-32-characters',
  INTEGRATION_SECRET_KEY: 'test-integration-secret-at-least-32-characters', TMDB_READ_ACCESS_TOKEN: 'tmdb-token', LOG_LEVEL: 'silent',
});

test('all provider settings routes isolate keys; readiness follows the default without replacing shared preferences', async () => {
  const records = new Map<string, AiConfigRecord>();
  const auth = { requireOwnerId: async (token: string | undefined) => {
    if (!token) throw new Error('missing test login');
    return token;
  } };
  let selected: AiProvider = 'openai';
  const services = Object.fromEntries(AI_PROVIDERS.map((provider) => {
    const key = (ownerId: string) => `${ownerId}:${provider}`;
    const store: AiConfigStore = {
      find: async (id) => records.get(key(id)) ?? null,
      save: async (record) => {
        records.set(key(record.ownerId), record);
        return true;
      },
      delete: async (id) => { records.delete(key(id)); },
      selectModel: async () => true, saveValidation: async () => true,
    };
    return [provider, new AiSettingsService(auth, store, new SecretCrypto(config.INTEGRATION_SECRET_KEY), {
      model: Object.keys(AI_MODEL_LIMITS[provider])[0]!, verify: async () => Object.keys(AI_MODEL_LIMITS[provider]),
    }, provider)];
  })) as AiSettingsRegistry;
  const app = await buildApp({ config, healthDependencies: [], aiSettings: services, authService: auth as never,
    integrationPreferencesService: { get: async () => ({ defaults: { ai: selected } }) } as never });
  try {
    for (const provider of AI_PROVIDERS) {
      const response = await app.inject({ method: 'PUT', url: `/api/v1/me/integrations/${provider}`,
        headers: { cookie: `${config.SESSION_COOKIE_NAME}=alice` }, payload: { apiKey: `private-${provider}-key-1234567890` } });
      assert.equal(response.statusCode, 200);
      assert.equal(response.json().provider, provider);
      assert.equal(response.json().validation.status, 'valid');
      assert.ok(!response.body.includes('private-'));
    }
    assert.equal(records.size, 3);
    assert.equal((await services.claude.get('bob')).configured, false);
    const original = records.get('alice:claude')!;
    records.set('alice:claude', { ...original, encryptedApiKey: records.get('alice:openai')!.encryptedApiKey });
    await assert.rejects(services.claude.requireCredentials('alice'));
    records.set('alice:claude', original);
    selected = 'claude';
    const ready = await app.inject({ method: 'GET', url: '/api/v1/me/integrations/ai', headers: { cookie: `${config.SESSION_COOKIE_NAME}=alice` } });
    assert.equal(ready.json().provider, 'claude');
    assert.equal(ready.json().configured, true);
    assert.ok(!ready.body.includes('encryptedApiKey'));
    assert.equal(records.size, 3);
  } finally { await app.close(); }
});
