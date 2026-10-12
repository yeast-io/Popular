import assert from 'node:assert/strict';
import test from 'node:test';
import { Value } from '@sinclair/typebox/value';
import { MyMoviesResponseSchema } from './movie-status.schema.js';

test('My Movies can expose a failed refresh without discarding the last successful availability', () => {
  assert.equal(Value.Check(MyMoviesResponseSchema, {
    items: [{
      tmdbId: 603,
      title: 'The Matrix',
      userStatus: 'interested',
      resourceCheck: {
        provider: 'mteam',
        availability: 'available',
        lastAttemptStatus: 'error',
        lastErrorCode: 'rate_limited',
      },
    }],
    pagination: { page: 1, pageSize: 20, total: 1, hasMore: false },
    locale: 'zh-CN',
  }), true);
});
