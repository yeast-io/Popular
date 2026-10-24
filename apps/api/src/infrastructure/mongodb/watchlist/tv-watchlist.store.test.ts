import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { createTvWatchlistModel, tvWatchlistSchema } from './tv-watchlist.schema.js';
import { MongoTvWatchlistStore } from './tv-watchlist.store.js';

test('TV watch list schema isolates user/title identity and indexes stable list order', () => {
  assert.equal(tvWatchlistSchema.options.collection, 'user_tv_watchlist');
  assert.ok(tvWatchlistSchema.indexes().some(([key, options]) => key.ownerId === 1 && key.tmdbId === 1 && options.unique));
  assert.ok(tvWatchlistSchema.indexes().some(([key]) => key.ownerId === 1 && key.createdAt === -1 && key._id === -1));
});
test('real Mongo watch list persists independent owners, concurrent idempotent adds and stable pagination', { skip: !process.env.POPULAR_TV_MONGO_TEST_URI }, async () => {
  const database = `popular_watchlist_test_${randomUUID().replaceAll('-', '')}`;
  const connection = await mongoose.createConnection(process.env.POPULAR_TV_MONGO_TEST_URI!, { dbName: database, serverSelectionTimeoutMS: 5000 }).asPromise();
  try {
    const model = createTvWatchlistModel(connection);
    await model.init();
    const store = new MongoTvWatchlistStore(model);
    const one = new mongoose.Types.ObjectId().toString();
    const two = new mongoose.Types.ObjectId().toString();
    await Promise.all(Array.from({ length: 5 }, () => store.add(one, 42)));
    await store.add(two, 42);
    assert.equal((await store.list(one, 1, 20)).total, 1);
    assert.equal(await store.contains(two, 42), true);
    await store.add(one, 43);
    const first = await store.list(one, 1, 1);
    const second = await store.list(one, 2, 1);
    assert.equal(first.total, 2);
    assert.notEqual(first.ids[0], second.ids[0]);
    await store.remove(one, 42);
    assert.equal(await store.contains(one, 42), false);
    assert.equal(await store.contains(two, 42), true);
  } finally {
    await connection.dropDatabase();
    await connection.close();
  }
});
