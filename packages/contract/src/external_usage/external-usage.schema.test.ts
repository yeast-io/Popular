import assert from 'node:assert/strict';
import test from 'node:test';
import { Value } from '@sinclair/typebox/value';
import { ExternalUsageQuerySchema, ExternalUsageResponseSchema } from './external-usage.schema.js';

const response = {
  range: { days: 30, from: '2026-09-14', to: '2026-10-13', timezone: 'UTC', retentionDays: 90 },
  totals: { requests: 3, successes: 2, failures: 1, averageDurationMs: 120 },
  providers: [
    { provider: 'future_tracker', requests: 3, successes: 2, failures: 1, averageDurationMs: 120 },
  ],
  daily: [
    { date: '2026-10-13', providers: [{ provider: 'future_tracker', requests: 3, successes: 2, failures: 1 }] },
  ],
  operations: [
    { provider: 'future_tracker', operation: 'release.search', requests: 3, successes: 2, failures: 1, averageDurationMs: 120 },
  ],
};

test('usage contracts accept supported ranges and dynamic provider ids', () => {
  assert.equal(Value.Check(ExternalUsageQuerySchema, {}), true);
  assert.equal(Value.Check(ExternalUsageQuerySchema, { days: 7 }), true);
  assert.equal(Value.Check(ExternalUsageQuerySchema, { days: 14 }), false);
  assert.equal(Value.Check(ExternalUsageResponseSchema, response), true);
});

test('usage contracts reject unsafe provider ids', () => {
  assert.equal(Value.Check(ExternalUsageResponseSchema, {
    ...response,
    providers: [{ ...response.providers[0], provider: 'unsafe provider' }],
  }), false);
});
