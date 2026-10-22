import assert from 'node:assert/strict';
import test from 'node:test';
import { MongoOpenAIConfigStore } from './openai-config.store.js';

test('replacing credentials always removes old validation; verification uses owner and ciphertext compare-and-set without upsert', async () => {
  const calls: Array<{ filter: unknown; update: Record<string, unknown>; options: Record<string, unknown> }> = [];
  let matchedCount = 1;
  const store = new MongoOpenAIConfigStore({
    updateOne: (filter: unknown, update: Record<string, unknown>, options: Record<string, unknown>) => {
      calls.push({ filter, update, options });
      return { exec: async () => ({ matchedCount }) };
    },
  } as never);
  await store.save({ ownerId: 'alice', encryptedApiKey: 'new-ciphertext', maskedApiKey: '••••1234' });
  assert.deepEqual(calls[0]?.update.$unset, { validation: 1, model: 1 });
  assert.deepEqual(calls[0]?.filter, { ownerId: 'alice' });
  const validation = {
    method: 'model_list' as const,
    status: 'valid' as const,
    models: ['model'],
    checkedAt: new Date().toISOString(),
  };
  assert.equal(await store.saveValidation('alice', 'new-ciphertext', validation), true);
  assert.deepEqual(calls[1]?.filter, { ownerId: 'alice', encryptedApiKey: 'new-ciphertext' });
  assert.equal(calls[1]?.options.upsert, undefined);
  matchedCount = 0;
  assert.equal(await store.saveValidation('alice', 'stale-ciphertext', validation), false);
});

test('model selection atomically checks account, key, successful validation and membership', async () => {
  let captured: unknown;
  const store = new MongoOpenAIConfigStore({
    updateOne: (filter: unknown, update: unknown, options: unknown) => {
      captured = { filter, update, options };
      return { exec: async () => ({ matchedCount: 1 }) };
    },
  } as never);
  assert.equal(await store.selectModel('alice', 'ciphertext', 'selected-model'), true);
  assert.deepEqual(captured, {
    filter: {
      'ownerId': 'alice',
      'encryptedApiKey': 'ciphertext',
      'validation.method': 'model_list',
      'validation.status': 'valid',
      'validation.models': 'selected-model',
    },
    update: { $set: { model: 'selected-model' } },
    options: { runValidators: true },
  }
  );
});
