import assert from 'node:assert/strict';
import test from 'node:test';
import { streamErrorDiagnostics } from './stream-error-diagnostics.js';

test('logs exception type, source location and database code without raw messages or values', () => {
  const error = Object.assign(new Error('E11000 private chat and sk-secret'), {
    name: 'MongoServerError', code: 11000, keyValue: { content: 'private chat and sk-secret' },
  });
  error.stack = 'MongoServerError: private chat and sk-secret\n    at insert (/app/conversation.store.ts:68:24)\n    at process.processTicksAndRejections (node:internal/process/task_queues:103:5)';
  assert.deepEqual(streamErrorDiagnostics(error), { causes: [{
    errorType: 'MongoServerError', databaseCode: 11000, locations: ['/app/conversation.store.ts:68:24'],
  }] });
});

test('limits cause depth and selects only known validation field names', () => {
  const error = Object.assign(new Error('private chat'), {
    name: 'ValidationError', errors: { outputTokens: { value: 'sk-secret' }, 'private chat': {} },
  });
  error.stack = 'ValidationError: private chat';
  error.cause = error;
  const diagnostics = streamErrorDiagnostics(error);
  assert.equal(diagnostics.causes.length, 5);
  assert.deepEqual(diagnostics.causes[0]?.validationFields, ['outputTokens']);
  assert.ok(!JSON.stringify(diagnostics).includes('private'));
  assert.ok(!JSON.stringify(diagnostics).includes('sk-secret'));
});

test('handles non-Error exceptions without logging their contents', () => {
  assert.deepEqual(streamErrorDiagnostics({ message: 'sk-secret', content: 'private chat' }), { causes: [] });
});
