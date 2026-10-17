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
    saveValidation: async (id, key, validation) => {
      const record = records.get(id); if (!record || record.encryptedApiKey !== key) return false;
      records.set(id, { ...record, validation }); return true;
    },
  };
  const auth = { requireOwnerId: async (token: string | undefined) => {
    if (token !== 'alice' && token !== 'bob') throw new AppError(401, 'UNAUTHORIZED', 'Login required');
    return token;
  } };
  const service = new OpenAISettingsService(auth, store, new SecretCrypto(config.INTEGRATION_SECRET_KEY));
  return { records, service, auth, store };
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

test('connection tests validate only the saved owner key, persist results, and reset after key or model replacement', async () => {
  const f = setup();
  const seen: string[] = [];
  const service = new OpenAISettingsService(f.auth, f.store, new SecretCrypto(config.INTEGRATION_SECRET_KEY), { model: 'test-model', verify: async key => { seen.push(key); } });
  await service.save('alice', aliceKey);
  const result = await service.test('alice');
  assert.equal(result.validation?.status, 'valid'); assert.equal(result.validation?.model, 'test-model'); assert.ok(result.validation?.checkedAt);
  assert.deepEqual(seen, [aliceKey]); assert.deepEqual((await service.get('alice')).validation, result.validation);
  assert.equal((await service.get('bob')).configured, false);
  assert.equal(JSON.stringify(result).includes(aliceKey), false);
  const changedModel = new OpenAISettingsService(f.auth, f.store, new SecretCrypto(config.INTEGRATION_SECRET_KEY), { model: 'new-model', verify: async () => undefined });
  assert.equal((await changedModel.get('alice')).validation, undefined);
  assert.equal(f.records.get('alice')?.validation?.status, 'valid');
  await service.save('alice', bobKey); assert.equal((await service.get('alice')).validation, undefined);
});

test('verification failures store only a safe reason and remain visible after reloading settings', async () => {
  const { OpenAIProbeError } = await import('./openai-settings.service.js');
  const f = setup(); await f.service.save('alice', aliceKey);
  const service = new OpenAISettingsService(f.auth, f.store, new SecretCrypto(config.INTEGRATION_SECRET_KEY), { model: 'test-model', verify: async () => { throw new OpenAIProbeError('quota'); } });
  const result = await service.test('alice');
  assert.equal(result.validation?.status, 'failed'); assert.equal(result.validation?.failureReason, 'quota');
  assert.deepEqual((await service.get('alice')).validation, result.validation);
  await assert.rejects(() => service.test('alice'), { code: 'CONFLICT' });
  await assert.rejects(() => service.test('bob'), { code: 'OPENAI_NOT_CONFIGURED' });
  await assert.rejects(() => service.test(undefined), { code: 'UNAUTHORIZED' });
});

test('concurrent tests share one request, and a stale result cannot validate a replaced or deleted key', async () => {
  for (const action of ['replace', 'delete'] as const) {
    const f = setup(); await f.service.save('alice', aliceKey);
    let release!: () => void;
    let started!: () => void;
    let calls = 0;
    const begun = new Promise<void>(resolve => { started = resolve; });
    const finished = new Promise<void>(resolve => { release = resolve; });
    const service = new OpenAISettingsService(f.auth, f.store, new SecretCrypto(config.INTEGRATION_SECRET_KEY), { model: 'test-model', verify: async () => { calls++; started(); await finished; } });
    const first = service.test('alice');
    const second = service.test('alice');
    await begun;
    if (action === 'replace') await service.save('alice', bobKey); else await service.delete('alice');
    release();
    const results = await Promise.allSettled([first, second]);
    assert.equal(calls, 1); assert.equal(results.every(result => result.status === 'rejected' && result.reason.code === 'CONFLICT'), true);
    assert.equal((await service.get('alice')).validation, undefined);
    assert.equal((await service.get('alice')).configured, action === 'replace');
  }
});

test('test HTTP route authenticates and ignores injected key, model and owner; returns only persisted metadata', async () => {
  const f = setup();
  await f.service.save('alice', aliceKey);
  let calls = 0;
  const service = new OpenAISettingsService(f.auth, f.store, new SecretCrypto(config.INTEGRATION_SECRET_KEY), { model: 'test-model', verify: async key => { assert.equal(key, aliceKey); calls++; } });
  const app = await buildApp({ config, healthDependencies: [], openaiSettingsService: service });
  try {
    const url = '/api/v1/me/integrations/openai/test';
    assert.equal((await app.inject({ method: 'POST', url })).statusCode, 401);
    const result = await app.inject({ method: 'POST', url, headers: { cookie: 'movie_hub_session=alice' }, payload: { apiKey: 'attacker', ownerId: 'bob', model: 'unwanted-model' } });
    assert.equal(result.statusCode, 200); assert.equal(result.json().validation.status, 'valid'); assert.equal(result.json().validation.model, 'test-model');
    assert.equal(calls, 1); assert.equal(result.body.includes(aliceKey), false); assert.equal(result.body.includes('encryptedApiKey'), false);
    assert.deepEqual(await service.get('bob'), { configured: false });
  } finally { await app.close(); }
});
