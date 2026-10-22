import assert from 'node:assert/strict';
import test from 'node:test';
import { Types } from 'mongoose';
import { MongoAssistantQueue } from './assistant-message.store.js';
import type { AssistantMessageModel } from './assistant-message.schema.js';

const conversation = { ownerId: '507f1f77bcf86cd799439011', channel: 'telegram' as const, chatId: '101' };
const id = new Types.ObjectId();

test('claim atomically targets the oldest unfinished message, even when that head is delayed', async () => {
  let filter: Record<string, unknown> = {};
  let update: Record<string, unknown> = {};
  const model = {
    findOne: (scope: Record<string, unknown>) => {
      assert.equal(String(scope.ownerId), conversation.ownerId);
      assert.equal(scope.chatId, '101');
      assert.deepEqual(scope.status, { $in: ['pending', 'processing'] });
      assert.equal(scope.nextAttemptAt, undefined);
      assert.equal(scope.messageId, undefined);
      assert.equal(scope.text, undefined);
      return {
        sort: (sort: unknown) => {
          assert.deepEqual(sort, { receivedAt: 1, _id: 1 });
          return { select: () => ({ lean: async () => ({ _id: id }) }) };
        },
      };
    },
    findOneAndUpdate: (query: Record<string, unknown>, change: Record<string, unknown>) => {
      filter = query;
      update = change;
      // The delayed head is ineligible; later messages must not be claimed instead.
      return { lean: async () => null };
    },
  } as unknown as AssistantMessageModel;
  const latestInput = { ...conversation, messageId: 'newer-message', text: 'hello' };
  assert.equal(await new MongoAssistantQueue(model).claim(latestInput, 'lease'), null);
  assert.equal(filter._id, id);
  const conditions = filter.$or as Array<Record<string, unknown>>;
  assert.equal(conditions[0]!.status, 'pending');
  assert.equal(conditions[1]!.status, 'processing');
  assert.ok(conditions[1]!.leaseUntil);
  assert.deepEqual(update.$inc, { attempts: 1 });
  assert.equal((update.$set as Record<string, unknown>).leaseId, 'lease');
});

test('recovery selects due conversation heads after grouping and includes expired leases', async () => {
  let pipeline: Array<Record<string, unknown>> = [];
  const model = {
    aggregate: async (steps: typeof pipeline) => {
      pipeline = steps;
      return [{ _id: { ...conversation, ownerId: new Types.ObjectId(conversation.ownerId) } }];
    },
  } as unknown as AssistantMessageModel;
  assert.deepEqual(await new MongoAssistantQueue(model).readyConversations(100), [conversation]);
  const grouping = pipeline.findIndex((step) => '$group' in step);
  const due = pipeline.findIndex((step) => JSON.stringify(step).includes('head.nextAttemptAt'));
  assert.ok(grouping >= 0 && due > grouping);
  assert.ok(JSON.stringify(pipeline[due]).includes('head.leaseUntil'));
  assert.deepEqual(pipeline.at(-1), { $limit: 100 });
});

test('renewals and result transitions are fenced by token, status, and an unexpired message lease', async () => {
  let matched = 0;
  const queries: Array<Record<string, unknown>> = [];
  const model = {
    updateOne: async (filter: Record<string, unknown>) => {
      queries.push(filter);
      return { matchedCount: matched };
    },
  } as unknown as AssistantMessageModel;
  const queue = new MongoAssistantQueue(model);
  assert.equal(await queue.renew(String(id), 'old'), false);
  assert.equal(await queue.saveResult(String(id), 'old', { replyText: 'stale' }), false);
  await queue.delivered(String(id), 'old');
  await queue.retry(String(id), 'old', false);
  for (const filter of queries) {
    assert.equal(filter._id, String(id));
    assert.equal(filter.leaseId, 'old');
    assert.equal(filter.status, 'processing');
    assert.ok((filter.leaseUntil as { $gt: Date }).$gt instanceof Date);
  }
  matched = 1;
  assert.equal(await queue.renew(String(id), 'current'), true);
});

test('persisted movie metadata and delivery progress survive reclaiming a message', async () => {
  const result = {
    intent: 'recommend' as const,
    replyText: 'Movie text',
    movies: [
      { tmdbId: 1, title: 'Movie', reason: 'Reason', posterPath: '/one.jpg' },
      { tmdbId: 2, title: 'No poster', reason: 'Reason' },
    ],
  };
  const updates: Array<Record<string, unknown>> = [];
  const row = {
    _id: id,
    ...conversation,
    ownerId: new Types.ObjectId(conversation.ownerId),
    messageId: 'message',
    text: 'Recommend',
    receivedAt: new Date(),
    attempts: 2,
    deliveredMovieCount: 1,
    ...result,
    movies: [result.movies[0], { ...result.movies[1], posterPath: null }],
  };
  const model = {
    findOne: () => ({ sort: () => ({ select: () => ({ lean: async () => ({ _id: id }) }) }) }),
    findOneAndUpdate: () => ({ lean: async () => row }),
    updateOne: async (_filter: unknown, update: Record<string, unknown>) => {
      updates.push(update);
      return { matchedCount: 1 };
    },
  } as unknown as AssistantMessageModel;
  const queue = new MongoAssistantQueue(model);
  assert.equal(await queue.saveResult(String(id), 'lease', result), true);
  assert.deepEqual(updates[0]?.$set, result);
  const job = await queue.claim(conversation, 'new-lease');
  assert.deepEqual(job?.result, result);
  assert.equal(job?.deliveredMovieCount, 1);
  assert.equal(await queue.markMovieDelivered(String(id), 'new-lease', 2), true);
  assert.deepEqual(updates.at(-1)?.$max, { deliveredMovieCount: 2 });
});

test('only final delivery/failure starts 90-day retention; pending retry clears expiration atomically', async () => {
  const updates: Array<Record<string, unknown>> = [];
  const filters: Array<Record<string, unknown>> = [];
  const model = {
    updateOne: async (filter: Record<string, unknown>, update: Record<string, unknown>) => {
      filters.push(filter);
      updates.push(update);
      return { matchedCount: 1 };
    },
  } as unknown as AssistantMessageModel;
  const queue = new MongoAssistantQueue(model);
  await queue.delivered(String(id), 'lease');
  await queue.retry(String(id), 'lease', true);
  await queue.retry(String(id), 'lease', false);
  for (const update of updates.slice(0, 2)) {
    const set = update.$set as { status: string; completedAt: Date; expiresAt: Date };
    assert.ok(['delivered', 'failed'].includes(set.status));
    assert.equal(set.expiresAt.getTime() - set.completedAt.getTime(), 90 * 24 * 60 * 60_000);
  }
  const retry = updates[2]!;
  assert.equal((retry.$set as Record<string, unknown>).status, 'pending');
  assert.equal((retry.$set as Record<string, unknown>).expiresAt, undefined);
  assert.deepEqual(retry.$unset, { leaseId: 1, leaseUntil: 1, completedAt: 1, expiresAt: 1 });
  for (const filter of filters) {
    assert.equal(filter.status, 'processing');
    assert.equal(filter.leaseId, 'lease');
    assert.ok(filter.leaseUntil);
  }
});

test('claiming unfinished work clears any stale retention fields before processing', async () => {
  let update: Record<string, unknown> = {};
  const model = {
    findOne: () => ({ sort: () => ({ select: () => ({ lean: async () => ({ _id: id }) }) }) }),
    findOneAndUpdate: (_filter: unknown, change: Record<string, unknown>) => {
      update = change;
      return { lean: async () => null };
    },
  } as unknown as AssistantMessageModel;
  await new MongoAssistantQueue(model).claim(conversation, 'lease');
  assert.deepEqual(update.$unset, { completedAt: 1, expiresAt: 1 });
});

test('expired delivered messages are excluded from model history before TTL physically removes them', async () => {
  let scope: Record<string, unknown> = {};
  const model = {
    find: (filter: Record<string, unknown>) => {
      scope = filter;
      return { sort: () => ({ limit: () => ({ lean: async () => [] }) }) };
    },
  } as unknown as AssistantMessageModel;
  await new MongoAssistantQueue(model).history({
    ...conversation,
    messageId: 'm1',
    text: 'query',
    receivedAt: new Date().toISOString(),
  }
  );
  assert.equal(String(scope.ownerId), conversation.ownerId);
  assert.equal(scope.status, 'delivered');
  const conditions = scope.$or as Array<{ expiresAt: { $gt?: Date; $exists?: boolean } }>;
  assert.ok(conditions[0]?.expiresAt.$gt instanceof Date);
  assert.equal(conditions[1]?.expiresAt.$exists, false);
});
