import assert from 'node:assert/strict';
import test from 'node:test';
import { buildApp } from '../../app.js';
import { loadConfig } from '../../config/env.js';
import { AppError } from '../../infrastructure/http/app-error.js';
import { ConversationTurnService } from '../conversations/conversation-turn.service.js';
import type { ConversationStore } from '../conversations/conversation.types.js';
import type { ConversationService } from '../conversations/conversation.service.js';
import { SecretCrypto } from './secret-crypto.js';
import { OpenAISettingsService, type OpenAIConfigRecord, type OpenAIConfigStore } from './openai-settings.service.js';

const config = loadConfig({
  WEB_ORIGIN: 'http://localhost:5173', MONGODB_URI: 'mongodb://db.example/movie_hub',
  REDIS_URL: 'redis://redis.example:6379', MINIO_ENDPOINT: 'minio.example',
  MINIO_ACCESS_KEY: 'access', MINIO_SECRET_KEY: 'secret', MINIO_BUCKET: 'avatars',
  SESSION_TOKEN_PEPPER: 'test-session-pepper-at-least-32-characters',
  INTEGRATION_SECRET_KEY: 'test-integration-secret-at-least-32-characters',
  TMDB_READ_ACCESS_TOKEN: 'tmdb-token', LOG_LEVEL: 'silent',
});

function setup() {
  const records = new Map<string, OpenAIConfigRecord>();
  const store: OpenAIConfigStore = {
    find: async (id) => records.get(id) ?? null,
    save: async (record) => { records.set(record.ownerId, record); },
    delete: async (id) => { records.delete(id); },
  };
  const auth = { requireOwnerId: async (token: string | undefined) => {
    if (token !== 'alice' && token !== 'bob') throw new AppError(401, 'UNAUTHORIZED', 'Login required');
    return token;
  } };
  const service = new OpenAISettingsService(auth, store, new SecretCrypto(config.INTEGRATION_SECRET_KEY));
  return { records, service };
}
const aliceKey = 'sk-test-alice-private-key-1234';
const bobKey = 'sk-test-bob-private-key-5678';

test('isolates, encrypts, replaces and deletes account keys without returning secrets', async () => {
  const { records, service } = setup();
  assert.deepEqual(await service.get('alice'), { configured: false });
  assert.deepEqual(await service.save('alice', aliceKey), { configured: true, maskedApiKey: '••••1234' });
  assert.deepEqual(await service.get('bob'), { configured: false });
  assert.ok(!JSON.stringify([...records.values()]).includes(aliceKey));
  await service.save('bob', bobKey);
  assert.equal(await service.requireApiKey('alice'), aliceKey);
  assert.equal(await service.requireApiKey('bob'), bobKey);
  await service.save('alice', 'sk-replacement-private-key-9999');
  assert.equal(await service.requireApiKey('alice'), 'sk-replacement-private-key-9999');
  await service.delete('alice');
  await assert.rejects(service.requireApiKey('alice'), { code: 'OPENAI_NOT_CONFIGURED' });
  assert.equal(await service.requireApiKey('bob'), bobKey);
  for (const method of [() => service.get(undefined), () => service.save(undefined, aliceKey), () => service.delete(undefined)]) {
    await assert.rejects(method(), { code: 'UNAUTHORIZED' });
  }
  await assert.rejects(service.save('alice', ' '.repeat(30)), { code: 'VALIDATION_ERROR' });
});

test('encrypted keys cannot be moved between accounts', async () => {
  const { records, service } = setup();
  await service.save('alice', aliceKey);
  records.set('bob', { ...records.get('alice')!, ownerId: 'bob' });
  await assert.rejects(service.requireApiKey('bob'));
});

test('settings HTTP API uses the session owner and never exposes plaintext or ciphertext', async () => {
  const { service } = setup();
  const app = await buildApp({ config, healthDependencies: [], openaiSettingsService: service });
  try {
    const url = '/api/v1/me/integrations/openai';
    for (const method of ['GET', 'PUT', 'DELETE'] as const) {
      const response = await app.inject({ method, url, ...(method === 'PUT' ? { payload: { apiKey: aliceKey } } : {}) });
      assert.equal(response.statusCode, 401);
    }
    const saved = await app.inject({ method: 'PUT', url, headers: { cookie: 'movie_hub_session=alice' }, payload: { apiKey: aliceKey, ownerId: 'bob' } });
    assert.equal(saved.statusCode, 200);
    assert.deepEqual(saved.json(), { configured: true, maskedApiKey: '••••1234' });
    const bob = await app.inject({ method: 'GET', url, headers: { cookie: 'movie_hub_session=bob' } });
    assert.deepEqual(bob.json(), { configured: false });
    const invalid = await app.inject({ method: 'PUT', url, headers: { cookie: 'movie_hub_session=alice' }, payload: { apiKey: ' '.repeat(30) } });
    assert.equal(invalid.statusCode, 400);
    const deleted = await app.inject({ method: 'DELETE', url, headers: { cookie: 'movie_hub_session=alice' } });
    assert.equal(deleted.statusCode, 204);
    assert.deepEqual(await service.get('alice'), { configured: false });
  } finally { await app.close(); }
});

test('missing key blocks normal and streaming turns before any message write', async () => {
  const { service } = setup();
  let writes = 0;
  const turn = new ConversationTurnService({ appendMessage: async () => { writes++; throw new Error('must not write'); } } as unknown as ConversationStore,
    async (ownerId) => { await service.requireApiKey(ownerId); throw new Error('must not call model'); },
    { count: (s) => s.length },
    { systemPrompt: 'test', maxContextTokens: 1000, maxOutputTokens: 10, summaryMaxOutputTokens: 10 });
  const app = await buildApp({
    config, healthDependencies: [], conversationService: {} as ConversationService, conversationTurnService: turn,
    authService: { requireOwnerId: async () => 'alice' } as never,
  });
  try {
    for (const suffix of ['turns', 'turns/stream']) {
      const response = await app.inject({ method: 'POST', url: `/api/v1/conversations/507f1f77bcf86cd799439011/${suffix}`, payload: { content: 'hello', clientRequestId: 'request-1' } });
      assert.equal(response.statusCode, 403);
      assert.equal(response.json().error.code, 'OPENAI_NOT_CONFIGURED');
      assert.ok(!String(response.headers['content-type']).includes('event-stream'));
    }
    assert.equal(writes, 0);
  } finally { await app.close(); }
});
