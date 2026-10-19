import assert from 'node:assert/strict';
import test from 'node:test';
import { MongoNotificationTestStore } from './notification-test.store.js';
test('list and manual send lookups always scope completion filters to the authenticated owner', async () => {
  const filters: Array<Record<string, unknown>> = [];
  const store = new MongoNotificationTestStore({
    find: (filter: Record<string, unknown>) => {
      filters.push(filter);
      return {
        sort: () => {
          return { skip: () => ({ limit: () => ({ lean: () => ({ exec: async () => [] }) }) }) };
        },
      };
    },
    findOne: (filter: Record<string, unknown>) => {
      filters.push(filter);
      return { lean: () => ({ exec: async () => null }) };
    },
  } as never);
  await store.listCompleted('alice', 0, 31);
  await store.findCompleted('alice', 'download-a');
  for (const filter of filters) {
    assert.equal(filter.ownerId, 'alice');
    assert.deepEqual(filter.$or, [
      { 'notificationTask.downloaded': true },
      { progress: { $gte: 100 }, status: { $in: ['completed', 'seeding', 'paused'] } },
    ]
    );
  }
  assert.equal(filters[1]?._id, 'download-a');
});
