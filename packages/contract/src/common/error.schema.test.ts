import assert from 'node:assert/strict';
import test from 'node:test';
import { Value } from '@sinclair/typebox/value';
import { ApiErrorSchema } from './error.schema.js';

test('API error protocol rejects internal fields', () => {
  const result = Value.Check(ApiErrorSchema, {
    error: { code: 'INTERNAL_ERROR', message: 'failed', requestId: 'req-1', stack: 'secret' },
  });
  assert.equal(result, false);
});
