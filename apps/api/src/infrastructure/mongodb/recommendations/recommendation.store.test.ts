import assert from 'node:assert/strict';
import test from 'node:test';
import { createConnection } from 'mongoose';
import { createRecommendationModel } from './recommendation.schema.js';
import { MongoRecommendationStore } from './recommendation.store.js';
import { emptyRecommendationState } from '../../../modules/recommendations/recommendation.domain.js';

test('recommendation schema retains existing model identity and owner/conversation uniqueness', async () => {
  const connection = createConnection();
  const model = createRecommendationModel(connection);
  assert.equal(model.modelName, 'RecommendationTask');
  assert.equal(model.collection.name, 'recommendationtasks');
  assert.ok(
    model.schema
      .indexes()
      .some(
        ([fields, options]) => fields.ownerId === 1 && fields.conversation === 1 && options.unique
      )
  );
  await connection.close();
});

test('recommendation persistence fences writes by owner, conversation and active lease', async () => {
  let filter: Record<string, unknown> | undefined;
  const model = {
    updateOne: (query: Record<string, unknown>) => {
      return {
        exec: async () => {
          filter = query;
          return { matchedCount: 1 };
        },
      };
    },
  };
  const store = new MongoRecommendationStore(model as unknown as ReturnType<typeof createRecommendationModel>);
  assert.ok(await store.save('alice', 'web:thread1', 'lease1', emptyRecommendationState()));
  assert.equal(filter?.ownerId, 'alice');
  assert.equal(filter?.conversation, 'web:thread1');
  assert.equal(filter?.leaseId, 'lease1');
  assert.ok(filter?.leaseUntil);
});
