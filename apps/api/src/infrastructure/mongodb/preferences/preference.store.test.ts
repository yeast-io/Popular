import assert from 'node:assert/strict';
import test from 'node:test';
import { MongoPreferenceStore } from './preference.store.js';
import { createPreferenceModels } from './preference.schema.js';
import { emptyProfile } from '../../../modules/preferences/preference.domain.js';
import { createConnection } from 'mongoose';

test('profile writes fence owner, version and applied-job receipt in one update', async () => {
  const updates: Array<{ filter: unknown; update: unknown }> = [];
  const profiles = { updateOne: (filter: unknown, update: unknown) => ({ exec: async () => {
    updates.push({ filter, update }); return { modifiedCount: 1 };
  } }) };
  const store = new MongoPreferenceStore({ profiles } as unknown as ReturnType<typeof createPreferenceModels>);
  const next = { ...emptyProfile(), version: 3 };
  assert.equal(await store.save('alice', 2, next, 'job1'), true);
  assert.deepEqual(updates[1]?.filter, { ownerId: 'alice', version: 2, appliedJobs: { $ne: 'job1' } });
  assert.deepEqual(updates[1]?.update, { $set: { data: next, version: 3 }, $addToSet: { appliedJobs: 'job1' } });
});
test('manual active slots and profile owners have database uniqueness', async () => {
  const connection = createConnection();
  const models = createPreferenceModels(connection);
  assert.ok(models.jobs.schema.indexes().some(([fields, options]) => fields.activeOwner === 1 && options.unique && options.sparse));
  assert.ok(models.profiles.schema.indexes().some(([fields, options]) => fields.ownerId === 1 && options.unique));
  await connection.close();
});
