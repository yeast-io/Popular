import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { createResourceNotificationModel } from './resource-notification.schema.js';
import { MongoResourceNotificationStore } from './resource-notification.store.js';
import { createResourceNotification } from '../../../modules/resource-notifications/resource-notification.domain.js';

const uri
  = process.env.POPULAR_RESOURCE_NOTIFICATION_MONGO_TEST_URI
    ?? (process.env.POPULAR_RESOURCE_NOTIFICATION_MONGO_TEST === 'true' ? process.env.MONGODB_URI : undefined);

test(
  'real Mongo atomically caps mixed media, isolates users, leases tasks and fences removed entries',
  { skip: !uri },
  async () => {
    const connection = await mongoose
      .createConnection(uri!, {
        dbName: `popular_resource_notifications_test_${randomUUID().replaceAll('-', '')}`,
        serverSelectionTimeoutMS: 5000,
      })
      .asPromise();
    try {
      const model = createResourceNotificationModel(connection);
      await model.init();
      const store = new MongoResourceNotificationStore(model);
      const one = new mongoose.Types.ObjectId().toString();
      const two = new mongoose.Types.ObjectId().toString();
      const now = new Date();
      await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          store.add(one, createResourceNotification(i % 2 ? 'movie' : 'tv', i + 1, 'Title', now))
        )
      );
      assert.equal((await store.list(one)).length, 5);
      const existing = (await store.list(one))[0]!;
      assert.equal(
        await store.add(one, createResourceNotification(existing.mediaType, existing.tmdbId, 'Duplicate', now)),
        true
      );
      assert.equal(await store.add(two, createResourceNotification('movie', 1, 'Other owner', now)), true);
      assert.equal((await store.list(two)).length, 1);
      const claims = (
        await Promise.all(Array.from({ length: 10 }, () => store.claim(now, new Date(now.getTime() + 10_800_000))))
      ).filter((claim) => claim !== null);
      assert.equal(claims.length, 6);
      assert.equal(new Set(claims.map((claim) => claim.entry.id)).size, 6);
      const claim = claims.find((claim) => claim.ownerId === two)!;
      assert.equal(await store.renew(claim, now), true);
      assert.equal(await store.markNotified(claim, now), true);
      await store.finish(claim, 'notified');
      assert.equal((await store.list(two))[0]!.status, 'notified');
      assert.equal(
        (await store.claim(new Date(now.getTime() + 10_800_000), new Date(now.getTime() + 21_600_000))) !== null,
        true
      );
      await store.remove(two, 'movie', 1);
      await store.add(two, createResourceNotification('movie', 1, 'Re-added', now));
      assert.equal(await store.renew(claim, now), false);
      assert.equal(await store.markNotified(claim, now), false);
      assert.equal((await store.list(two))[0]!.status, 'pending');
    } finally {
      await connection.dropDatabase();
      await connection.close();
    }
  }
);
