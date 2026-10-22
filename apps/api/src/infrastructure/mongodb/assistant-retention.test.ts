import assert from 'node:assert/strict';
import test from 'node:test';
import { createConnection } from 'mongoose';
import { createAssistantMessageModel, type AssistantMessageModel } from './assistant/assistant-message.schema.js';
import type { createResourceQueryModel } from './resource-query/resource-query.schema.js';
import {
  initializeAssistantRetention,
  ASSISTANT_MESSAGE_RETENTION_MS,
  RESOURCE_QUERY_RETENTION_MS,
} from './assistant-retention.js';

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

test('legacy retention migration is restricted to unexpired-field terminal messages and preserves update timestamps', async () => {
  const operations: Array<{ filter: Record<string, unknown>; update: unknown; options: unknown }> = [];
  const model = {
    updateMany: (filter: Record<string, unknown>, update: unknown, options: unknown) => {
      operations.push({ filter, update, options });
      return { exec: async () => ({ modifiedCount: 1 }) };
    },
  };
  await initializeAssistantRetention(
    model as unknown as AssistantMessageModel,
    model as unknown as ReturnType<typeof createResourceQueryModel>,
    { verbose: false }
  );
  assert.deepEqual(operations[0]?.filter, { status: { $in: ['delivered', 'failed'] }, expiresAt: { $exists: false } });
  assert.deepEqual(operations[1]?.filter, { expiresAt: { $exists: false } });
  for (const operation of operations)
    assert.deepEqual(operation.options, { timestamps: false, hint: { expiresAt: 1 } });
  assert.match(JSON.stringify(operations[0]?.update), /\$completedAt/);
  assert.match(JSON.stringify(operations[0]?.update), /\$updatedAt/);
  assert.match(JSON.stringify(operations[0]?.update), /\$\$NOW/);
  assert.ok(JSON.stringify(operations[0]?.update).includes(String(ASSISTANT_MESSAGE_RETENTION_MS)));
  assert.match(JSON.stringify(operations[1]?.update), /\$leaseUntil/);
  assert.ok(JSON.stringify(operations[1]?.update).includes(String(RESOURCE_QUERY_RETENTION_MS)));
});

test('backfill failure keeps its original cause and diagnostics even with verbose off', async () => {
  const error = new Error('retention backfill failed', { cause: new Error('database unavailable') });
  const errors: Record<string, unknown>[] = [];
  const infos: unknown[] = [];
  const messages = {
    updateMany: () => ({
      exec: async () => {
        throw error;
      },
    }),
  } as unknown as AssistantMessageModel;
  const resources = {
    updateMany: () => {
      throw new Error('must not execute');
    },
  } as unknown as ReturnType<typeof createResourceQueryModel>;
  await assert.rejects(
    initializeAssistantRetention(messages, resources, {
      verbose: false,
      logger: {
        error: (entry: Record<string, unknown>) => {
          return errors.push(entry);
        },
        info: (entry: Record<string, unknown>) => {
          return infos.push(entry);
        },
      },
    }
    ),
    (actual) => actual === error
  );
  assert.equal(infos.length, 0);
  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.stage, 'assistant.retention.messages.backfill');
  assert.ok(errors[0]?.correlationId);
  assert.match(JSON.stringify(errors), /cause|stack/);
});
