import assert from 'node:assert/strict';
import test from 'node:test';
import { createConnection } from 'mongoose';
import { createResourceQueryModel, MongoResourceQueryStore } from './resource-query.store.js';
import { emptyResourceState } from '../../../modules/resource-query/resource-query.types.js';

test('resource query schema enforces owner/conversation uniqueness', async () => {
  const connection = createConnection();
  const model = createResourceQueryModel(connection);
  assert.equal(model.collection.name, 'assistantresourcequeries');
  assert.ok(
    model.schema.indexes().some(
      ([fields, options]) => fields.ownerId === 1 && fields.conversation === 1 && options.unique
    )
  );
  await connection.close();
});

test('resource query reads, lease acquisition, saves and release always scope the owner and conversation', async () => {
  const queries: Record<string, unknown>[] = [];
  const updates: Record<string, unknown>[] = [];
  let matchedCount = 1;
  const query = (filter: Record<string, unknown>, update?: Record<string, unknown>) => {
    queries.push(filter);
    if (update) updates.push(update);
    return { lean: () => {
      return ({ exec: async () => ({ data: emptyResourceState() }) });
    }, exec: async () => {
      return ({ matchedCount });
    } };
  };
  const model = { findOne: query, updateOne: query, findOneAndUpdate: query };
  const store = new MongoResourceQueryStore(model as unknown as ReturnType<typeof createResourceQueryModel>);
  await store.ensure('alice', 'web:thread');
  await store.read('alice', 'web:thread');
  assert.equal(await store.acquire('alice', 'web:thread', 'lease1'), true);
  assert.ok(queries.at(-1)?.$or);
  assert.equal(await store.save('alice', 'web:thread', 'lease1', emptyResourceState()), true);
  assert.equal(queries.at(-1)?.leaseId, 'lease1');
  assert.ok(queries.at(-1)?.leaseUntil);
  matchedCount = 0;
  assert.equal(await store.save('alice', 'web:thread', 'expired', emptyResourceState()), false);
  await store.release('alice', 'web:thread', 'lease1');
  assert.equal(queries.at(-1)?.leaseId, 'lease1');
  assert.deepEqual(updates.at(-1)?.$unset, { leaseId: 1, leaseUntil: 1 });
  assert.ok((updates.at(-1)?.$set as { expiresAt: Date }).expiresAt instanceof Date);
  for (const filter of queries) {
    assert.equal(filter.ownerId, 'alice');
    assert.equal(filter.conversation, 'web:thread');
  }
});

test('resource TTL uses a root BSON date, and ensure resets expired state while protecting active leases', async () => {
  const connection = createConnection();
  const model = createResourceQueryModel(connection);
  assert.equal(model.schema.path('expiresAt').instance, 'Date');
  assert.ok(
    model.schema.indexes().some(([fields, options]) => fields.expiresAt === 1 && options.expireAfterSeconds === 0)
  );
  await connection.close();
  let pipeline: Array<{ $set: Record<string, unknown> }> = [];
  const now = Date.now();
  const store = new MongoResourceQueryStore({ updateOne: (_filter: unknown, update: typeof pipeline) => {
    pipeline = update; return { exec: async () => ({ matchedCount: 1 }) };
  } } as unknown as ReturnType<typeof createResourceQueryModel>);
  await store.ensure('alice', '$literal-chat');
  const set = pipeline[0]!.$set;
  assert.deepEqual(set.conversation, { $literal: '$literal-chat' });
  assert.ok((set.expiresAt as Date).getTime() >= now + 24 * 60 * 60_000);
  const conditions = (set.data as { $cond: unknown[] }).$cond;
  assert.deepEqual(conditions[1], { $literal: emptyResourceState() });
  assert.match(JSON.stringify(conditions[0]), /\$expiresAt/);
  assert.match(JSON.stringify(conditions[0]), /\$leaseUntil/);
  assert.match(JSON.stringify(conditions[2]), /\$ifNull/);
});

test('logical expiry filters old resource rows even if MongoDB has not deleted them yet', async () => {
  let scope: Record<string, unknown> = {};
  const store = new MongoResourceQueryStore({ findOne: (filter: Record<string, unknown>) => {
    scope = filter; return { lean: () => ({ exec: async () => null }) };
  } } as unknown as ReturnType<typeof createResourceQueryModel>);
  assert.equal(await store.read('alice', 'web:thread'), null);
  assert.equal(scope.ownerId, 'alice');
  const conditions = scope.$or as Array<{ expiresAt: { $gt?: Date; $exists?: boolean } }>;
  assert.ok(conditions[0]?.expiresAt.$gt instanceof Date);
  assert.equal(conditions[1]?.expiresAt.$exists, false);
});
