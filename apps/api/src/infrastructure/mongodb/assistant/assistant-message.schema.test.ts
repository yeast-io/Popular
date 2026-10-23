import assert from 'node:assert/strict';
import test from 'node:test';
import { createConnection } from 'mongoose';
import { createAssistantMessageModel } from './assistant-message.schema.js';

test('message expiry has an independent TTL index and date fields without a default expiration', async () => {
  const connection = createConnection();
  const model = createAssistantMessageModel(connection);
  assert.equal(model.schema.path('expiresAt').instance, 'Date');
  assert.equal(model.schema.path('completedAt').instance, 'Date');
  assert.equal(model.schema.path('expiresAt').options.default, undefined);
  assert.ok(
    model.schema.indexes().some(([fields, options]) => fields.expiresAt === 1 && options.expireAfterSeconds === 0)
  );
  const pending = new model({ status: 'pending' });
  assert.equal(pending.expiresAt, undefined);
  await connection.close();
});
