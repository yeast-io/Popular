import assert from 'node:assert/strict';
import test from 'node:test';
import type { Model } from 'mongoose';
import type { ExternalRequestEventDocument } from './external-request-event.schema.js';
import type { ExternalUsageDailyDocument } from './external-usage-daily.schema.js';
import { dailyAggregationPipeline, MongoExternalUsageStore } from './external-usage.store.js';

test('event retention is exactly 90 days and invalid attribution is rejected', async () => {
  const created: Array<Record<string, unknown>> = [];
  const errors: Array<Record<string, unknown>> = [];
  const events = {
    create: async (value: Record<string, unknown>) => {
      created.push(value);
    },
  } as unknown as Model<ExternalRequestEventDocument>;
  const daily = { collection: { name: 'external_usage_daily' } } as unknown as Model<ExternalUsageDailyDocument>;
  const store = new MongoExternalUsageStore(events, daily, {
    error: (bindings) => {
      errors.push(bindings);
    },
  });
  const occurredAt = new Date('2026-10-13T12:00:00.000Z');

  await store.record({
    actorType: 'user',
    ownerId: '507f1f77bcf86cd799439011',
    provider: 'tmdb',
    operation: 'movie.details',
    trigger: 'api_request',
    outcome: 'success',
    operationId: 'operation-1',
    attempt: 1,
    durationMs: 12,
    occurredAt,
  }
  );
  await store.record({
    actorType: 'user',
    provider: 'tmdb',
    operation: 'movie.details',
    trigger: 'api_request',
    outcome: 'success',
    operationId: 'operation-2',
    attempt: 1,
    durationMs: 12,
    occurredAt,
  }
  );

  assert.equal(created.length, 1);
  assert.equal((created[0]?.expiresAt as Date).toISOString(), '2027-01-11T12:00:00.000Z');
  assert.equal(errors.length, 1);
});

test('daily aggregation produces both global and user scopes and merges idempotently', () => {
  const pipeline = dailyAggregationPipeline(new Date('2026-10-12T00:00:00.000Z'), 'external_usage_daily');
  const serialized = JSON.stringify(pipeline);
  assert.match(serialized, /"global"/);
  assert.match(serialized, /user:/);
  assert.match(serialized, /"whenMatched":"replace"/);
  assert.match(serialized, /"amount":91/);
});

test('personal usage aggregation always scopes events by owner and date range', async () => {
  let pipeline: unknown[] = [];
  const events = {
    aggregate: (value: unknown[]) => {
      pipeline = value;
      return { exec: async () => [] };
    },
  } as unknown as Model<ExternalRequestEventDocument>;
  const daily = { collection: { name: 'external_usage_daily' } } as unknown as Model<ExternalUsageDailyDocument>;
  const store = new MongoExternalUsageStore(events, daily, { error: () => undefined });

  await store.readUserUsage(
    '507f1f77bcf86cd799439011',
    new Date('2026-10-01T00:00:00.000Z'),
    new Date('2026-10-14T00:00:00.000Z')
  );

  const serialized = JSON.stringify(pipeline);
  assert.match(serialized, /507f1f77bcf86cd799439011/);
  assert.match(serialized, /\$gte/);
  assert.match(serialized, /\$lt/);
  assert.match(serialized, /"providers"/);
  assert.match(serialized, /"operations"/);
});
