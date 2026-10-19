import assert from 'node:assert/strict';
import test from 'node:test';
import { createConnection } from 'mongoose';
import { createAssistantSessionModel } from './assistant-session.schema.js';

test('workflow session schema enforces owner/conversation uniqueness', async () => {
  const connection = createConnection();
  const model = createAssistantSessionModel(connection);
  assert.equal(model.collection.name, 'assistantworkflowsessions');
  assert.ok(
    model.schema.indexes().some(
      ([fields, options]) => fields.ownerId === 1 && fields.conversation === 1 && options.unique
    )
  );
  assert.equal(model.schema.path('expiresAt').instance, 'Date');
  assert.ok(
    model.schema.indexes().some(([fields, options]) => fields.expiresAt === 1 && options.expireAfterSeconds === 0)
  );
  await connection.close();
});
