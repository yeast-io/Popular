import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { createTvPreferenceModel } from './tv-preference.schema.js';
import { MongoTvPreferenceStore } from './tv-preference.store.js';

test('TV preference schema has an owner/show unique key and rejects invalid values', async () => {
  const connection = mongoose.createConnection();
  const model = createTvPreferenceModel(connection);
  try {
    assert.equal(model.collection.collectionName, 'user_tv_preferences');
    assert.ok(model.schema.indexes().some(([fields, options]) => fields.ownerId === 1 && fields.tmdbId === 1 && options.unique));
    assert.ok(new model({ ownerId: new mongoose.Types.ObjectId(), tmdbId: 1.5, preference: 'neutral' }).validateSync());
  } finally {
    await connection.destroy();
  }
});
test('real Mongo TV preferences persist, isolate users and serialize concurrent toggles into one row', { skip: !process.env.POPULAR_TV_MONGO_TEST_URI }, async () => {
  const connection = await mongoose.createConnection(process.env.POPULAR_TV_MONGO_TEST_URI!, { dbName: `popular_tv_preference_test_${randomUUID().replaceAll('-', '')}`, serverSelectionTimeoutMS: 5000 }).asPromise();
  try {
    const model = createTvPreferenceModel(connection);
    await model.init();
    const store = new MongoTvPreferenceStore(model);
    const first = new mongoose.Types.ObjectId().toString();
    const second = new mongoose.Types.ObjectId().toString();
    await Promise.all(Array.from({ length: 5 }, () => store.set(first, 42, 'liked')));
    assert.equal(await model.countDocuments({ ownerId: first, tmdbId: 42 }), 1);
    assert.deepEqual(await store.read(second, [42]), []);
    await store.set(second, 42, 'liked');
    await store.set(first, 42, 'disliked');
    assert.deepEqual(await store.read(first, [42]), [{ tmdbId: 42, preference: 'disliked' }]);
    assert.deepEqual(await new MongoTvPreferenceStore(model).read(second, [42]), [{ tmdbId: 42, preference: 'liked' }]);
    await store.clear(first, 42);
    await store.clear(first, 42);
    assert.deepEqual(await store.read(first, [42]), []);
    assert.equal(await model.countDocuments({ ownerId: second }), 1);
  } finally {
    await connection.dropDatabase();
    await connection.close();
  }
});
