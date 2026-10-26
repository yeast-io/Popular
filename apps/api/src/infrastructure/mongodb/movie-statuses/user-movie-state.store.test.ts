import assert from 'node:assert/strict';
import test from 'node:test';
import type { Model } from 'mongoose';
import type { UserMovieStateDocument } from './user-movie-state.schema.js';
import { MongoMovieStatusStore } from './user-movie-state.store.js';

test('movie notification writes require owner and interested membership without reordering or upserting', async () => {
  const calls: unknown[][] = [];
  let matchedCount = 1;
  const model = { updateOne: (...args: unknown[]) => {
    calls.push(args);
    return { exec: async () => ({ matchedCount }) };
  } } as unknown as Model<UserMovieStateDocument>;
  const store = new MongoMovieStatusStore(model);
  assert.equal(await store.setResourceNotification('one', 42, true), true);
  assert.deepEqual(calls[0], [{ ownerId: 'one', tmdbId: 42, status: 'interested' }, { $set: { resourceNotificationEnabled: true } }, { timestamps: false }]);
  matchedCount = 0;
  assert.equal(await store.setResourceNotification('two', 42, false), false);
});

test('movie state mapping restores saved notification flags and defaults existing rows to off', async () => {
  const rows = [
    { tmdbId: 1, status: 'interested', preference: 'neutral', updatedAt: new Date(), resourceNotificationEnabled: true },
    { tmdbId: 2, status: 'interested', preference: 'liked', updatedAt: new Date() },
  ];
  const model = { find: () => ({ lean: () => ({ exec: async () => rows }) }) } as unknown as Model<UserMovieStateDocument>;
  const store = new MongoMovieStatusStore(model);
  const result = await store.readForMovies('one', [1, 2]);
  assert.deepEqual(result.map((row) => row.resourceNotificationEnabled), [true, false]);
  assert.deepEqual(result.map((row) => row.preference), ['neutral', 'liked']);
});
