import assert from 'node:assert/strict';
import test from 'node:test';
import mongoose from 'mongoose';
import { createResourceNotificationModel, resourceNotificationSchema } from './resource-notification.schema.js';
import { createResourceNotification } from '../../../modules/resource-notifications/resource-notification.domain.js';

test('resource notifications have unique user ownership and persist constrained mixed-media entries', async () => {
  assert.equal(resourceNotificationSchema.options.collection, 'resource_notifications');
  assert.ok(resourceNotificationSchema.indexes().some(([key, options]) => key.ownerId === 1 && options.unique));
  const connection = mongoose.createConnection();
  try {
    const model = createResourceNotificationModel(connection);
    const entries = Array.from({ length: 5 }, (_, i) =>
      createResourceNotification(i % 2 ? 'movie' : 'tv', i + 1, 'Title', new Date())
    );
    const row = new model({ ownerId: new mongoose.Types.ObjectId(), entries });
    await row.validate();
    assert.equal(row.entries.length, 5);
    row.entries.push(createResourceNotification('movie', 6, 'Extra', new Date()));
    await assert.rejects(row.validate(), /entries/);
  } finally {
    await connection.close();
  }
});
