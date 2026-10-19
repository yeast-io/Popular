import assert from 'node:assert/strict';
import test from 'node:test';
import type { createAssistantSessionModel } from './assistant-session.schema.js';
import { MongoAssistantSessionStore } from './assistant-session.store.js';
import { emptyAssistantSession } from '../../../modules/assistant/assistant-session.domain.js';

test('workflow session reads, lease acquisition, saves and release always scope the owner and conversation', async () => {
  const queries: Record<string, unknown>[] = [];
  const updates: Record<string, unknown>[] = [];
  let matchedCount = 1;
  const query = (filter: Record<string, unknown>, update?: Record<string, unknown>) => {
    queries.push(filter);
    if (update) updates.push(update);
    return { lean: () => {
      return ({ exec: async () => ({ data: emptyAssistantSession() }) });
    }, exec: async () => {
      return ({ matchedCount });
    } };
  };
  const model = { findOne: query, updateOne: query, findOneAndUpdate: query };
  const store = new MongoAssistantSessionStore(model as unknown as ReturnType<typeof createAssistantSessionModel>);
  await store.ensure('alice', 'web:thread');
  await store.read('alice', 'web:thread');
  assert.equal(await store.acquire('alice', 'web:thread', 'lease1'), true);
  assert.ok(queries.at(-1)?.$or);
  assert.equal(await store.save('alice', 'web:thread', 'lease1', emptyAssistantSession()), true);
  assert.equal(queries.at(-1)?.leaseId, 'lease1');
  assert.ok(queries.at(-1)?.leaseUntil);
  matchedCount = 0;
  assert.equal(await store.save('alice', 'web:thread', 'expired', emptyAssistantSession()), false);
  await store.release('alice', 'web:thread', 'lease1');
  assert.equal(queries.at(-1)?.leaseId, 'lease1');
  assert.deepEqual(updates.at(-1)?.$unset, { leaseId: 1, leaseUntil: 1 });
  assert.ok((updates.at(-1)?.$set as { expiresAt: Date }).expiresAt instanceof Date);
  for (const filter of queries) {
    assert.equal(filter.ownerId, 'alice');
    assert.equal(filter.conversation, 'web:thread');
  }
});

test('workflow session TTL uses a root BSON date, and ensure resets expired state while protecting active leases', async () => {
  let pipeline: Array<{ $set: Record<string, unknown> }> = [];
  const now = Date.now();
  const store = new MongoAssistantSessionStore({ updateOne: (_filter: unknown, update: typeof pipeline) => {
    pipeline = update; return { exec: async () => ({ matchedCount: 1 }) };
  } } as unknown as ReturnType<typeof createAssistantSessionModel>);
  await store.ensure('alice', '$literal-chat');
  const set = pipeline[0]!.$set;
  assert.deepEqual(set.conversation, { $literal: '$literal-chat' });
  assert.ok((set.expiresAt as Date).getTime() >= now + 24 * 60 * 60_000);
  const conditions = (set.data as { $cond: unknown[] }).$cond;
  assert.deepEqual(conditions[1], { $literal: emptyAssistantSession() });
  assert.match(JSON.stringify(conditions[0]), /\$expiresAt/);
  assert.match(JSON.stringify(conditions[0]), /\$leaseUntil/);
  assert.match(JSON.stringify(conditions[2]), /\$ifNull/);
});

test('logical expiry filters old workflow rows even if MongoDB has not deleted them yet', async () => {
  let scope: Record<string, unknown> = {};
  const store = new MongoAssistantSessionStore({ findOne: (filter: Record<string, unknown>) => {
    scope = filter; return { lean: () => ({ exec: async () => null }) };
  } } as unknown as ReturnType<typeof createAssistantSessionModel>);
  assert.equal(await store.read('alice', 'web:thread'), null);
  assert.equal(scope.ownerId, 'alice');
  const conditions = scope.$or as Array<{ expiresAt: { $gt?: Date; $exists?: boolean } }>;
  assert.ok(conditions[0]?.expiresAt.$gt instanceof Date);
  assert.equal(conditions[1]?.expiresAt.$exists, false);
});
