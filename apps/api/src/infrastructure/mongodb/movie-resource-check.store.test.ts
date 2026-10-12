import assert from 'node:assert/strict';
import test from 'node:test';
import type { Model } from 'mongoose';
import type { MovieResourceCheckDocument } from './movie-resource-check.schema.js';
import type { MovieResourceCheckTaskDocument } from './movie-resource-check-task.schema.js';
import { MongoMovieResourceCheckStore } from './movie-resource-check.store.js';

const key = { ownerId: '507f1f77bcf86cd799439011', tmdbId: 603, provider: 'mteam' as const };
const attemptedAt = new Date('2026-10-13T00:00:00.000Z');

function harness(state: Partial<MovieResourceCheckDocument> | null = null) {
  const calls: Array<{ operation: 'state' | 'task' | 'release'; filter: unknown; update?: unknown }> = [];
  const checks = {
    findOne: () => ({ lean: () => ({ exec: async () => state }) }),
    updateOne(filter: unknown, update: unknown) {
      calls.push({ operation: 'state', filter, update });
      return { exec: async () => ({}) };
    },
  } as unknown as Model<MovieResourceCheckDocument>;
  const tasks = {
    findOneAndUpdate(filter: unknown, update: unknown) {
      calls.push({ operation: 'task', filter, update });
      return { lean: () => ({ exec: async () => ({}) }) };
    },
    findOneAndDelete(filter: unknown) {
      calls.push({ operation: 'release', filter });
      return { lean: () => ({ exec: async () => ({}) }) };
    },
    deleteOne(filter: unknown) {
      calls.push({ operation: 'release', filter });
      return { exec: async () => ({}) };
    },
  } as unknown as Model<MovieResourceCheckTaskDocument>;
  return { calls, store: new MongoMovieResourceCheckStore(checks, tasks) };
}

test('acquiring a check puts checking in task state and preserves the previous resource result', async () => {
  const previousCheck = new Date('2026-10-12T00:00:00.000Z');
  const { calls, store } = harness({
    availability: 'available',
    matchedBy: 'imdb',
    checkedAt: previousCheck,
    expiresAt: new Date('2026-10-12T12:00:00.000Z'),
    lastAttemptAt: previousCheck,
    lastAttemptStatus: 'success',
  });
  const leaseExpiresAt = new Date('2026-10-13T00:02:00.000Z');

  await store.tryAcquire(
    key,
    attemptedAt,
    leaseExpiresAt,
    new Date('2026-10-12T23:55:00.000Z'),
    false,
  );

  assert.deepEqual(calls[0]?.update, {
    $setOnInsert: { ...key },
    $set: { status: 'checking', attemptedAt, leaseExpiresAt },
  });
  assert.deepEqual(calls[1]?.update, {
    $setOnInsert: { ...key, availability: 'unchecked' },
  });
  assert.equal(JSON.stringify(calls[1]?.update).includes('lastAttemptStatus'), false);
  assert.equal(JSON.stringify(calls[1]?.update).includes('availability":"available'), false);
});

test('a failed refresh updates attempt metadata without replacing the previous successful result', async () => {
  const { calls, store } = harness();

  await store.complete(key, attemptedAt, {
    lastAttemptStatus: 'error',
    lastErrorCode: 'timeout',
  });

  assert.deepEqual(calls[1]?.update, {
    $set: {
      lastAttemptStatus: 'error',
      lastErrorCode: 'timeout',
      lastAttemptAt: attemptedAt,
    },
  });
  assert.equal(calls[0]?.operation, 'release');
});

test('a successful check stores only the movie-level availability result and clears the last error', async () => {
  const { calls, store } = harness();
  const checkedAt = new Date('2026-10-13T00:00:03.000Z');
  const expiresAt = new Date('2026-10-14T00:00:03.000Z');

  await store.complete(key, attemptedAt, {
    lastAttemptStatus: 'success',
    availability: 'unavailable',
    matchedBy: 'imdb',
    checkedAt,
    expiresAt,
  });

  assert.deepEqual(calls[1]?.update, {
    $set: {
      lastAttemptStatus: 'success',
      availability: 'unavailable',
      matchedBy: 'imdb',
      checkedAt,
      expiresAt,
      lastAttemptAt: attemptedAt,
    },
    $unset: { lastErrorCode: 1 },
  });
});

test('an unmatchable result clears an older IMDb match without using checking as availability', async () => {
  const { calls, store } = harness();
  const checkedAt = new Date('2026-10-13T00:00:03.000Z');

  await store.complete(key, attemptedAt, {
    lastAttemptStatus: 'success',
    availability: 'unmatchable',
    checkedAt,
    expiresAt: new Date('2026-10-14T00:00:03.000Z'),
  });

  const update = calls[1]?.update as { $set: Record<string, unknown>; $unset: Record<string, unknown> };
  assert.equal(update.$set.availability, 'unmatchable');
  assert.deepEqual(update.$unset, { lastErrorCode: 1, matchedBy: 1 });
});
