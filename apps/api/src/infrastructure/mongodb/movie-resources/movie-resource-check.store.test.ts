import assert from 'node:assert/strict';
import test from 'node:test';
import type { Model } from 'mongoose';
import { Types } from 'mongoose';
import type { MovieResourceCheckDocument } from './movie-resource-check.schema.js';
import type { MovieResourceCheckTaskDocument } from './movie-resource-check-task.schema.js';
import { MongoMovieResourceCheckStore } from './movie-resource-check.store.js';

const key = { ownerId: '507f1f77bcf86cd799439011', tmdbId: 603, provider: 'mteam' as const };
const attemptedAt = new Date('2026-10-13T00:00:00.000Z');

function harness(
  state: Partial<MovieResourceCheckDocument> | null = null,
  taskRows: Array<Partial<MovieResourceCheckTaskDocument>> = [],
) {
  const calls: Array<{ operation: 'read' | 'state' | 'task' | 'release'; filter: unknown; update?: unknown }> = [];
  const checks = {
    findOne: () => ({ lean: () => ({ exec: async () => state }) }),
    find(filter: unknown) {
      calls.push({ operation: 'read', filter });
      return { lean: () => ({ exec: async () => state ? [state] : [] }) };
    },
    updateOne(filter: unknown, update: unknown) {
      calls.push({ operation: 'state', filter, update });
      return { exec: async () => ({}) };
    },
  } as unknown as Model<MovieResourceCheckDocument>;
  const tasks = {
    find: () => ({ lean: () => ({ exec: async () => taskRows }) }),
    findOne: () => ({ lean: () => ({ exec: async () => null }) }),
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

test('reads only display-safe resource check state for the requested owner and movies', async () => {
  const checkedAt = new Date('2026-10-12T00:00:00.000Z');
  const ownerId = new Types.ObjectId(key.ownerId);
  const { calls, store } = harness({
    ...key,
    ownerId,
    availability: 'available',
    checkedAt,
    lastAttemptAt: attemptedAt,
    lastAttemptStatus: 'error',
    lastErrorCode: 'rate_limited',
  });

  assert.deepEqual(await store.readForMovies(key.ownerId, [key.tmdbId]), [{
    ...key,
    checking: false,
    availability: 'available',
    checkedAt,
    lastAttemptAt: attemptedAt,
    lastAttemptStatus: 'error',
    lastErrorCode: 'rate_limited',
  }]);
  assert.deepEqual(calls[0], {
    operation: 'read',
    filter: { ownerId: key.ownerId, tmdbId: { $in: [key.tmdbId] }, provider: 'mteam' },
  });
});

test('reads legacy resource checks without availability as unchecked', async () => {
  const ownerId = new Types.ObjectId(key.ownerId);
  const { store } = harness({
    ...key,
    ownerId,
    lastAttemptAt: attemptedAt,
    lastAttemptStatus: 'error',
    lastErrorCode: 'invalid_response',
  });

  assert.equal((await store.readForMovies(key.ownerId, [key.tmdbId]))[0]?.availability, 'unchecked');
  assert.equal((await store.readOne(key))?.availability, 'unchecked');
});

test('returns checking for an active task even before a result row exists', async () => {
  const { store } = harness(null, [{
    ...key,
    ownerId: new Types.ObjectId(key.ownerId),
    attemptedAt,
    leaseExpiresAt: new Date('2026-10-13T00:02:00.000Z'),
  }]);

  assert.deepEqual(await store.readForMovies(key.ownerId, [key.tmdbId]), [{
    ...key,
    checking: true,
    availability: 'unchecked',
  }]);
});

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
    '["The Matrix","tt0133093"]',
    new Date('2026-10-12T00:00:00.000Z'),
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
  assert.deepEqual(calls[2], {
    operation: 'state',
    filter: { ...key, availability: { $exists: false } },
    update: { $set: { availability: 'unchecked' } },
  });
  assert.equal(calls[0]?.operation, 'release');
});

test('a failed live query preserves the last successful checkedAt and availability fields', async () => {
  const { calls, store } = harness();

  await store.recordAttempt(key, attemptedAt, {
    lastAttemptStatus: 'error',
    lastErrorCode: 'network',
  });

  const call = calls[0];
  assert.deepEqual(call?.filter, {
    ...key,
    $or: [
      { lastAttemptAt: { $exists: false } },
      { lastAttemptAt: { $lte: attemptedAt } },
    ],
  });
  assert.deepEqual(call?.update, {
    $set: { lastAttemptStatus: 'error', lastErrorCode: 'network', lastAttemptAt: attemptedAt },
    $setOnInsert: { ...key, availability: 'unchecked' },
  });
  assert.deepEqual(calls[1], {
    operation: 'state',
    filter: { ...key, availability: { $exists: false } },
    update: { $set: { availability: 'unchecked' } },
  });
  assert.equal(JSON.stringify(call?.update).includes('checkedAt'), false);
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
    $unset: { lastErrorCode: 1, identityFingerprint: 1 },
  });
});

test('an unmatchable result clears an older IMDb match without using checking as availability', async () => {
  const { calls, store } = harness();
  const checkedAt = new Date('2026-10-13T00:00:03.000Z');

  await store.complete(key, attemptedAt, {
    lastAttemptStatus: 'success',
    availability: 'unmatchable',
    checkedAt,
    identityFingerprint: '["The Matrix",null]',
  });

  const update = calls[1]?.update as { $set: Record<string, unknown>; $unset: Record<string, unknown> };
  assert.equal(update.$set.availability, 'unmatchable');
  assert.deepEqual(update.$unset, { lastErrorCode: 1, matchedBy: 1, expiresAt: 1 });
});

test('an unmatchable result is due only after matching metadata changes', async () => {
  const state = {
    availability: 'unmatchable' as const,
    identityFingerprint: '["Old title",null]',
    checkedAt: new Date('2026-10-12T00:00:00.000Z'),
    lastAttemptAt: new Date('2026-10-12T00:00:00.000Z'),
    lastAttemptStatus: 'success' as const,
  };
  const unchanged = harness(state);
  const changed = harness(state);

  assert.equal(await unchanged.store.tryAcquire(
    key, attemptedAt, new Date('2026-10-13T00:02:00.000Z'),
    new Date('2026-10-12T23:45:00.000Z'), '["Old title",null]', undefined, false,
  ), false);
  assert.equal(await changed.store.tryAcquire(
    key, attemptedAt, new Date('2026-10-13T00:02:00.000Z'),
    new Date('2026-10-12T23:45:00.000Z'), '["New title","tt1234567"]', undefined, false,
  ), true);
});

test('a transient failure observes its retry delay even when the previous cache expired', async () => {
  const recentFailure = harness({
    availability: 'available',
    checkedAt: new Date('2026-10-12T00:00:00.000Z'),
    expiresAt: new Date('2026-10-12T06:00:00.000Z'),
    lastAttemptAt: new Date('2026-10-12T23:50:00.000Z'),
    lastAttemptStatus: 'error',
    lastErrorCode: 'timeout',
  });

  assert.equal(await recentFailure.store.tryAcquire(
    key, attemptedAt, new Date('2026-10-13T00:02:00.000Z'),
    new Date('2026-10-12T23:45:00.000Z'), '["The Matrix","tt0133093"]', undefined, false,
  ), false);
});

test('authentication failure remains blocked until newer credentials are verified', async () => {
  const state = {
    availability: 'unchecked' as const,
    lastAttemptAt: new Date('2026-10-12T23:50:00.000Z'),
    lastAttemptStatus: 'error' as const,
    lastErrorCode: 'authentication' as const,
  };
  const unchanged = harness(state);
  const updated = harness(state);

  assert.equal(await unchanged.store.tryAcquire(
    key, attemptedAt, new Date('2026-10-13T00:02:00.000Z'),
    new Date('2026-10-12T23:45:00.000Z'), undefined,
    new Date('2026-10-12T23:40:00.000Z'), true,
  ), false);
  assert.equal(await updated.store.tryAcquire(
    key, attemptedAt, new Date('2026-10-13T00:02:00.000Z'),
    new Date('2026-10-12T23:45:00.000Z'), undefined,
    new Date('2026-10-12T23:55:00.000Z'), false,
  ), true);
});
