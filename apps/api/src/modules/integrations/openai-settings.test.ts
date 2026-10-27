import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { buildApp } from '../../app.js';
import { loadConfig } from '../../config/env.js';
import { AppError } from '../../infrastructure/http/app-error.js';
import { ConversationTurnService } from '../conversations/conversation-turn.service.js';
import type { ConversationStore } from '../conversations/conversation.types.js';
import type { ConversationService } from '../conversations/conversation.service.js';
import { SecretCrypto } from './secret-crypto.js';
import { OpenAIProbeError, OpenAISettingsService } from './openai-settings.service.js';
import type { OpenAIConfigRecord, OpenAIConfigStore, OpenAIVerification } from './openai-settings.types.js';

const config = loadConfig({
  WEB_ORIGIN: 'http://localhost:5173',
  MONGODB_URI: 'mongodb://db.example/movie_hub',
  REDIS_URL: 'redis://redis.example:6379',
  MINIO_ENDPOINT: 'minio.example',
  MINIO_ACCESS_KEY: 'access',
  MINIO_SECRET_KEY: 'secret',
  MINIO_BUCKET: 'avatars',
  SESSION_TOKEN_PEPPER: 'test-session-pepper-at-least-32-characters',
  INTEGRATION_SECRET_KEY: 'test-integration-secret-at-least-32-characters',
  TMDB_READ_ACCESS_TOKEN: 'tmdb-token',
  LOG_LEVEL: 'silent',
});

const aliceKey = 'sk-test-alice-private-key-1234';
const bobKey = 'sk-test-bob-private-key-5678';

function setup(t?: TestContext, verification?: OpenAIVerification) {
  let now = Date.now();
  if (t) t.mock.method(Date, 'now', () => now);
  const records = new Map<string, OpenAIConfigRecord>();
  const store: OpenAIConfigStore = {
    find: async (id) => records.get(id) ?? null,
    save: async (record, expected) => {
      if ((records.get(record.ownerId)?.encryptedApiKey ?? null) !== expected) return false;
      records.set(record.ownerId, record);
      return true;
    },
    delete: async (id) => {
      records.delete(id);
    },
    selectModel: async (id, key, model) => {
      const record = records.get(id);
      if (!record || record.encryptedApiKey !== key || record.validation?.status !== 'valid'
        || !record.validation.models.includes(model)) return false;
      records.set(id, { ...record, model });
      return true;
    },
    saveValidation: async (id, key, validation) => {
      const record = records.get(id);
      if (!record || record.encryptedApiKey !== key) return false;
      records.set(id, { ...record, validation });
      return true;
    },
  };
  const auth = { requireOwnerId: async (token: string | undefined) => {
    if (token !== 'alice' && token !== 'bob') throw new AppError(401, 'UNAUTHORIZED', 'Login required');
    return token;
  } };
  const secrets = new SecretCrypto(config.INTEGRATION_SECRET_KEY);
  const service = new OpenAISettingsService(auth, store, secrets, verification ?? {
    model: 'model-a', verify: async () => ['model-a', 'model-b'],
  });
  const seed = (ownerId = 'alice', key = aliceKey) => {
    records.set(ownerId, { ownerId, encryptedApiKey: secrets.encrypt(key, `movie-hub:integration:openai:owner:${ownerId}`),
      maskedApiKey: `••••${key.slice(-4)}` });
  };
  return { records, store, auth, secrets, service, seed, advance: () => {
    now += 30_001;
  } };
}

test('verifies before encrypting and saving; isolates accounts and supports replacement and deletion', async (t) => {
  const f = setup(t);
  assert.deepEqual(await f.service.get('alice'), { configured: false });
  const saved = await f.service.save('alice', aliceKey);
  assert.equal(saved.validation?.status, 'valid');
  assert.equal(saved.maskedApiKey, '••••1234');
  assert.equal(saved.model, 'model-a');
  assert.ok(!JSON.stringify([...f.records.values()]).includes(aliceKey));
  assert.ok(!JSON.stringify(saved).includes('encryptedApiKey'));
  assert.deepEqual(await f.service.get('bob'), { configured: false });
  await f.service.save('bob', bobKey);
  assert.equal(await f.service.requireApiKey('alice'), aliceKey);
  assert.equal(await f.service.requireApiKey('bob'), bobKey);
  f.advance();
  await f.service.save('alice', bobKey);
  assert.equal(await f.service.requireApiKey('alice'), bobKey);
  await f.service.delete('alice');
  await assert.rejects(f.service.requireApiKey('alice'), { code: 'OPENAI_NOT_CONFIGURED' });
  assert.equal(await f.service.requireApiKey('bob'), bobKey);
  await assert.rejects(f.service.save(undefined, aliceKey), { code: 'UNAUTHORIZED' });
  await assert.rejects(f.service.delete(undefined), { code: 'UNAUTHORIZED' });
  await assert.rejects(f.service.save('alice', ' '.repeat(30)), { code: 'VALIDATION_ERROR' });
});

test('encrypted keys cannot be moved between accounts', async (t) => {
  const f = setup(t);
  await f.service.save('alice', aliceKey);
  f.records.set('bob', { ...f.records.get('alice')!, ownerId: 'bob' });
  await assert.rejects(f.service.requireApiKey('bob'));
});

test('failed first verification never saves a key; failed replacement preserves key, model and validation', async (t) => {
  let fail = true;
  const f = setup(t, { model: 'model-a', verify: async () => {
    if (fail) throw new OpenAIProbeError('authentication');
    return ['model-a', 'model-b'];
  } });
  await assert.rejects(f.service.save('alice', aliceKey), { code: 'INTEGRATION_VALIDATION_FAILED',
    details: { provider: 'openai', reason: 'authentication' } });
  assert.equal(f.records.size, 0);
  fail = false;
  f.advance();
  await f.service.save('alice', aliceKey);
  await f.service.selectModel('alice', 'model-b');
  const previous = f.records.get('alice');
  fail = true;
  f.advance();
  await assert.rejects(f.service.save('alice', bobKey), { code: 'INTEGRATION_VALIDATION_FAILED' });
  assert.deepEqual(f.records.get('alice'), previous);
  assert.deepEqual(await f.service.requireCredentials('alice'), { apiKey: aliceKey, model: 'model-b' });
});

test('a key is not stored while verification is pending; concurrent saves are rejected', async (t) => {
  let release!: (models: string[]) => void;
  const f = setup(t, { model: 'model-a', verify: () => new Promise((resolve) => {
    release = resolve;
  }) });
  const first = f.service.save('alice', aliceKey);
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.records.size, 0);
  await assert.rejects(f.service.save('alice', bobKey), { code: 'CONFLICT' });
  release(['model-a']);
  assert.equal((await first).validation?.status, 'valid');
});

test('replacement verification cannot restore a deleted key or overwrite another saved key', async () => {
  for (const action of ['delete', 'replace'] as const) {
    let release!: (models: string[]) => void;
    const f = setup(undefined, { model: 'model-a', verify: () => new Promise((resolve) => {
      release = resolve;
    }) });
    f.seed();
    const pending = f.service.save('alice', bobKey);
    while (!release) await new Promise((resolve) => setImmediate(resolve));
    if (action === 'delete') await f.service.delete('alice');
    else f.seed('alice', 'sk-key-saved-by-another-process');
    release(['model-a']);
    await assert.rejects(pending, { code: 'CONFLICT' });
    assert.equal((await f.service.get('alice')).configured, action === 'replace');
  }
});

test('legacy saved keys hide models until verified; repeated tests share requests and enforce cooldown', async (t) => {
  let calls = 0;
  const f = setup(t, { model: 'model-a', verify: async (key) => {
    calls++;
    assert.equal(key, aliceKey);
    return ['model-a', 'model-b'];
  } });
  f.seed();
  assert.equal((await f.service.get('alice')).model, undefined);
  const results = await Promise.all([f.service.test('alice'), f.service.test('alice')]);
  assert.equal(calls, 1);
  assert.deepEqual(results[0], results[1]);
  assert.equal(results[0]?.validation?.status, 'valid');
  assert.equal((await f.service.get('alice')).model, 'model-a');
  await assert.rejects(f.service.test('alice'), { code: 'CONFLICT' });
  await assert.rejects(f.service.save('alice', bobKey), { code: 'CONFLICT' });
  await assert.rejects(f.service.test('bob'), { code: 'OPENAI_NOT_CONFIGURED' });
  await assert.rejects(f.service.test(undefined), { code: 'UNAUTHORIZED' });
});

test('saved-key verification failures persist safe reasons and stale results cannot validate deleted keys', async () => {
  const f = setup(undefined, { model: 'model-a', verify: async () => {
    throw new OpenAIProbeError('quota');
  } });
  f.seed();
  assert.equal((await f.service.test('alice')).validation?.failureReason, 'quota');
  assert.equal((await f.service.get('alice')).validation?.status, 'failed');
  let release!: (models: string[]) => void;
  const g = setup(undefined, { model: 'model-a', verify: () => new Promise((resolve) => {
    release = resolve;
  }) });
  g.seed();
  const pending = g.service.test('alice');
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  await g.service.delete('alice');
  release(['model-a']);
  await assert.rejects(pending, { code: 'CONFLICT' });
});

test('model selection is owner isolated, curated and used by actual assistant credentials', async (t) => {
  const f = setup(t, { model: 'model-a', recommendedModels: ['model-a', 'model-b'],
    verify: async (key) => key === aliceKey ? ['model-a', 'model-b', 'whisper-1'] : ['model-b'] });
  f.seed();
  await assert.rejects(f.service.selectModel('alice', 'model-a'), { code: 'VALIDATION_ERROR' });
  await f.service.test('alice');
  await f.service.save('bob', bobKey);
  assert.deepEqual((await f.service.get('alice')).validation?.models, ['model-a', 'model-b']);
  await assert.rejects(f.service.selectModel('alice', 'whisper-1'), { code: 'VALIDATION_ERROR' });
  await assert.rejects(f.service.selectModel('bob', 'model-a'), { code: 'VALIDATION_ERROR' });
  await assert.rejects(f.service.selectModel(undefined, 'model-b'), { code: 'UNAUTHORIZED' });
  await f.service.selectModel('alice', 'model-b');
  assert.deepEqual(await f.service.requireCredentials('alice'), { apiKey: aliceKey, model: 'model-b' });
  f.advance();
  await f.service.save('alice', bobKey);
  assert.equal((await f.service.get('alice')).model, 'model-b');
});

test('settings HTTP routes enforce verification, localize failures and never expose secrets', async (t) => {
  let fail = false;
  const f = setup(t, { model: 'model-a', verify: async () => {
    if (fail) throw new OpenAIProbeError('authentication');
    return ['model-a', 'model-b'];
  } });
  const app = await buildApp({ config, healthDependencies: [], openaiSettingsService: f.service });
  const url = '/api/v1/me/integrations/openai';
  const headers = { 'cookie': 'movie_hub_session=alice', 'accept-language': 'zh-CN' };
  try {
    for (const method of ['GET', 'PUT', 'DELETE'] as const) {
      assert.equal((await app.inject({ method, url, ...(method === 'PUT' ? { payload: { apiKey: aliceKey } } : {}) })).statusCode, 401);
    }
    const result = await app.inject({ method: 'PUT', url, headers, payload: { apiKey: aliceKey, ownerId: 'bob' } });
    assert.equal(result.statusCode, 200);
    assert.equal(result.json().validation.status, 'valid');
    assert.equal(result.body.includes(aliceKey), false);
    assert.equal(result.body.includes('encryptedApiKey'), false);
    assert.equal((await f.service.get('bob')).configured, false);
    const selected = await app.inject({ method: 'PUT', url: `${url}/model`, headers, payload: { model: 'model-b' } });
    assert.equal(selected.statusCode, 200);
    assert.equal((await f.service.requireCredentials('alice')).model, 'model-b');
    f.advance();
    fail = true;
    const failed = await app.inject({ method: 'PUT', url, headers, payload: { apiKey: bobKey } });
    assert.equal(failed.statusCode, 400);
    assert.equal(failed.json().error.details.reason, 'authentication');
    assert.equal(failed.json().error.message, 'OpenAI 密钥验证失败');
    assert.equal(await f.service.requireApiKey('alice'), aliceKey);
    assert.equal((await app.inject({ method: 'DELETE', url, headers })).statusCode, 204);
  } finally {
    await app.close();
  }
});

test('missing key blocks normal and streaming turns before any message write', async () => {
  const { service } = setup();
  let writes = 0;
  const turn = new ConversationTurnService(
    {
      appendMessage: async () => {
        writes++;
        throw new Error('must not write');
      },
    } as unknown as ConversationStore,
    async (ownerId) => {
      await service.requireApiKey(ownerId);
      throw new Error('must not call model');
    },
    { count: (s) => s.length },
    { systemPrompt: 'test', maxContextTokens: 1000, maxOutputTokens: 10, summaryMaxOutputTokens: 10 }
  );
  const app = await buildApp({
    config,
    healthDependencies: [],
    conversationService: {} as ConversationService,
    conversationTurnService: turn,
    authService: { requireOwnerId: async () => 'alice' } as never,
  }
  );
  try {
    for (const suffix of ['turns', 'turns/stream']) {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/conversations/507f1f77bcf86cd799439011/${suffix}`,
        payload: { content: 'hello', clientRequestId: 'request-1' },
      }
      );
      assert.equal(response.statusCode, 403);
      assert.equal(response.json().error.code, 'OPENAI_NOT_CONFIGURED');
      assert.ok(!String(response.headers['content-type']).includes('event-stream'));
    }
    assert.equal(writes, 0);
  } finally {
    await app.close();
  }
});

test('unavailable verification never stores a key, and an empty curated list does not select an inaccessible model', async () => {
  const f = setup();
  const unavailable = new OpenAISettingsService(f.auth, f.store, f.secrets);
  await assert.rejects(unavailable.save('alice', aliceKey), { code: 'SERVICE_UNAVAILABLE' });
  assert.equal(f.records.size, 0);
  const service = new OpenAISettingsService(f.auth, f.store, f.secrets, {
    model: 'inaccessible-model', recommendedModels: [], verify: async () => ['whisper-1'],
  });
  const result = await service.save('alice', aliceKey);
  assert.deepEqual(result.validation?.models, []);
  assert.equal(f.records.get('alice')?.model, undefined);
  await assert.rejects(service.selectModel('alice', 'whisper-1'), { code: 'VALIDATION_ERROR' });
});

test('saved-key HTTP verification accepts an empty body and ignores client credentials', async (t) => {
  const f = setup(t, { model: 'model-a', verify: async (key) => {
    assert.equal(key, aliceKey);
    return ['model-a'];
  } });
  f.seed();
  const app = await buildApp({ config, healthDependencies: [], openaiSettingsService: f.service });
  try {
    const url = '/api/v1/me/integrations/openai/test';
    const headers = { cookie: 'movie_hub_session=alice' };
    assert.equal((await app.inject({ method: 'POST', url })).statusCode, 401);
    const first = await app.inject({ method: 'POST', url, headers });
    assert.equal(first.statusCode, 200);
    assert.equal(first.json().validation.status, 'valid');
    f.advance();
    const second = await app.inject({ method: 'POST', url, headers, payload: { apiKey: bobKey, ownerId: 'bob' } });
    assert.equal(second.statusCode, 200);
    assert.equal(f.records.has('bob'), false);
  } finally {
    await app.close();
  }
});

test('model saves detect stale credentials and curated changes apply to saved metadata', async (t) => {
  const f = setup(t);
  await f.service.save('alice', aliceKey);
  const changed = new OpenAISettingsService(f.auth, { ...f.store, selectModel: async () => false }, f.secrets,
    { model: 'model-a', recommendedModels: ['model-b'], verify: async () => [] });
  assert.deepEqual((await changed.get('alice')).validation?.models, ['model-b']);
  await assert.rejects(changed.selectModel('alice', 'model-a'), { code: 'VALIDATION_ERROR' });
  await assert.rejects(changed.selectModel('alice', 'model-b'), { code: 'CONFLICT' });
  assert.equal((await f.service.requireCredentials('alice')).model, 'model-a');
});
