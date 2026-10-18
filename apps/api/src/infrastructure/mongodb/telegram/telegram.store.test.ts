import assert from 'node:assert/strict';
import test from 'node:test';
import mongoose from 'mongoose';
import { createTelegramModel } from './telegram.schema.js';
import { MongoTelegramStore } from './telegram.store.js';

test('owner and chat uniqueness are database enforced; link hashes are excluded by default', () => {
  const model = createTelegramModel(mongoose.createConnection());
  const indexes = model.schema.indexes();
  for (const name of ['ownerId', 'chatId', 'pendingHash']) assert.ok(indexes.some(([fields, options]) => fields[name] === 1 && options.unique));
  assert.equal(model.schema.path('pendingHash').options.select, false);
  // Expiry must not TTL-delete a connected owner document.
  assert.ok(!indexes.some(([, options]) => options.expireAfterSeconds !== undefined));
});
test('incoming chat lookup returns only its bound owner, or null for an unknown chat', async () => {
  let row: { ownerId: string } | null = { ownerId: 'alice' };
  const store = new MongoTelegramStore({ findOne: (filter: unknown) => {
    assert.deepEqual(filter, { chatId: '101' });
    return { select: (fields: string) => { assert.equal(fields, 'ownerId'); return { lean: () => ({ exec: async () => row }) }; } };
  } } as never);
  assert.equal(await store.findOwnerByChatId('101'), 'alice');
  row = null;
  assert.equal(await store.findOwnerByChatId('101'), null);
});

test('consume is one atomic conditional write; expired, reused or already-bound links cannot match', async () => {
  let filter: Record<string, unknown> = {};
  let update: Record<string, unknown> = {};
  const store = new MongoTelegramStore({ updateOne: (f: typeof filter, u: typeof update) => { filter = f; update = u; return { exec: async () => ({ modifiedCount: 1 }) }; } } as never);
  const now = new Date();
  assert.equal(await store.consume('hash', '101', '@alice', now), true);
  assert.deepEqual(filter, { pendingHash: 'hash', expiresAt: { $gt: now }, chatId: { $exists: false } });
  assert.deepEqual(update, { $set: { chatId: '101', account: '@alice' }, $unset: { pendingHash: 1, expiresAt: 1 } });
});
test('duplicate binding conflicts fail without overwriting existing records; unexpected storage errors propagate', async () => {
  let code = 11000;
  const store = new MongoTelegramStore({ updateOne: () => ({ exec: async () => { throw { code }; } }) } as never);
  assert.equal(await store.pending('owner', 'hash', new Date()), false);
  assert.equal(await store.consume('hash', '101', 'alice', new Date()), false);
  code = 123;
  await assert.rejects(() => store.consume('hash', '101', 'alice', new Date()));
});
