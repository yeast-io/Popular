import assert from 'node:assert/strict';
import test from 'node:test';
import { ExternalUsageService } from './external-usage.service.js';
import type { ExternalUsageReader } from './external-usage.types.js';

test('returns only the authenticated owner usage and fills missing UTC days', async () => {
  let query: { ownerId: string; from: Date; to: Date } | undefined;
  const reader: ExternalUsageReader = {
    readUserUsage: async (ownerId, from, to) => {
      query = { ownerId, from, to };
      return {
        totals: { requests: 3, successes: 2, failures: 1, totalDurationMs: 361 },
        providers: [{ provider: 'future_tracker', requests: 3, successes: 2, failures: 1, totalDurationMs: 361 }],
        daily: [{ date: '2026-10-13', provider: 'future_tracker', requests: 3, successes: 2, failures: 1 }],
        operations: [
          {
            provider: 'future_tracker',
            operation: 'release.search',
            requests: 3,
            successes: 2,
            failures: 1,
            totalDurationMs: 361,
          },
        ],
      };
    },
  };
  const service = new ExternalUsageService(
    { requireOwnerId: async () => '507f1f77bcf86cd799439011' },
    reader,
    () => new Date('2026-10-13T22:30:00.000Z')
  );

  const result = await service.readMine('session', 7);

  assert.deepEqual(query, {
    ownerId: '507f1f77bcf86cd799439011',
    from: new Date('2026-10-07T00:00:00.000Z'),
    to: new Date('2026-10-14T00:00:00.000Z'),
  }
  );
  assert.equal(result.daily.length, 7);
  assert.deepEqual(result.daily.at(-1), {
    date: '2026-10-13',
    providers: [{ provider: 'future_tracker', requests: 3, successes: 2, failures: 1 }],
  }
  );
  assert.equal(result.totals.averageDurationMs, 120);
  assert.equal(result.providers[0]?.provider, 'future_tracker');
});

test('token totals, unknown counts, and per-model operations reach the user response without fee fields', async () => {
  const tokenUsage = {
    inputTokens: 100,
    outputTokens: 20,
    cachedInputTokens: 40,
    knownRequests: 1,
    unknownRequests: 1,
    unknownCachedRequests: 1,
  };
  const metric = { requests: 2, successes: 1, failures: 1, totalDurationMs: 100, tokenUsage };
  const service = new ExternalUsageService(
    { requireOwnerId: async () => 'alice' },
    {
      readUserUsage: async (owner) => {
        assert.equal(owner, 'alice');
        return {
          totals: metric,
          providers: [{ provider: 'openai', ...metric }],
          daily: [{ date: '2026-10-18', provider: 'openai', ...metric }],
          operations: [{ provider: 'openai', operation: 'assistant.intent', ...metric }],
          models: [{ provider: 'openai', model: 'test-model', operation: 'assistant.intent', ...metric }],
        };
      },
    },
    () => new Date('2026-10-18T01:00:00Z')
  );
  const result = await service.readMine('session', 7);
  assert.deepEqual(result.totals.tokenUsage, tokenUsage);
  assert.deepEqual(result.providers[0]!.tokenUsage, tokenUsage);
  assert.deepEqual(result.daily.at(-1)!.providers[0]!.tokenUsage, tokenUsage);
  assert.equal(result.models![0]!.model, 'test-model');
  assert.equal(result.models![0]!.averageDurationMs, 50);
  assert.ok(!JSON.stringify(result).includes('cost'));
});
