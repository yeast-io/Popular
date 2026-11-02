import assert from 'node:assert/strict';
import test from 'node:test';
import mongoose from 'mongoose';
import { createAiConfigModel } from './ai-config.schema.js';
import { MongoAiConfigStore } from './ai-config.store.js';

test('configuration schema uniquely scopes a provider to an owner and excludes encrypted credentials', () => {
  const connection = mongoose.createConnection();
  const model = createAiConfigModel(connection);
  assert.equal(model.collection.name, 'ai_configs');
  assert.ok(model.schema.indexes().some(([fields, options]) => fields.ownerId === 1 && fields.provider === 1 && options.unique));
  assert.equal(model.schema.path('encryptedApiKey').options.select, false);
});

test('key replacement, selection and verification use provider/owner/ciphertext/revision compare-and-set', async () => {
  const calls: Array<{ filter: Record<string, unknown>; update: Record<string, unknown> }> = [];
  const store = new MongoAiConfigStore({ updateOne: (filter: Record<string, unknown>, update: Record<string, unknown>) => {
    calls.push({ filter, update });
    return { exec: async () => ({ matchedCount: 1 }) };
  } } as never, 'claude');
  await store.save({ ownerId: 'alice', encryptedApiKey: 'new', maskedApiKey: '••••1234', revision: 3 }, 'old');
  await store.selectModel('alice', 'new', 'claude-sonnet-5-5', 4);
  await store.saveValidation('alice', 'new', { method: 'model_list', status: 'valid', checkedAt: new Date().toISOString(), models: [] }, 5);
  assert.deepEqual(calls[0]?.filter, { ownerId: 'alice', provider: 'claude', encryptedApiKey: 'old', revision: 3 });
  assert.equal(calls[1]?.filter.revision, 4);
  assert.equal(calls[2]?.filter.revision, 5);
  assert.ok(calls.every((call) => call.filter.provider === 'claude' && call.filter.ownerId === 'alice'));
});

test('a credential-free deletion tombstone prevents legacy key resurrection', async () => {
  let legacyReads = 0;
  let removed = false;
  let unset: unknown;
  const store = new MongoAiConfigStore({
    findOne: () => ({ select: () => ({ lean: () => ({ exec: async () => removed ? { removed: true } : null }) }) }),
    updateOne: (_filter: unknown, update: { $unset: unknown }) => ({ exec: async () => {
      removed = true;
      unset = update.$unset;
    } }),
  } as never, 'openai', {
    find: async () => {
      legacyReads++;
      return null;
    },
    delete: async () => {}, save: async () => true, selectModel: async () => true, saveValidation: async () => true,
  });
  await store.delete('alice');
  assert.equal(await store.find('alice'), null);
  assert.equal(legacyReads, 0);
  assert.deepEqual(unset, { encryptedApiKey: 1, maskedApiKey: 1, model: 1, validation: 1 });
});
