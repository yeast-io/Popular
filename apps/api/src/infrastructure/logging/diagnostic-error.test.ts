import assert from 'node:assert/strict';
import test from 'node:test';
import { serializeDiagnosticError } from './diagnostic-error.js';
import { AiTrace, aiStep, withAiTrace } from './ai-trace.js';

test('preserves full error stack and causes but redacts keys, prompts and database values', () => {
  const cause = Object.assign(
    new Error('E11000 duplicate key index: thread_1_request_1 dup key: { content: "private answer" }'),
    {
      name: 'MongoServerError',
      code: 11000,
      keyValue: { content: 'private answer' },
      keyPattern: { threadId: 1, clientRequestId: 1 },
    },
  );
  const error = new Error('Failed to save private answer with sk-test-secret and Bearer abc123', { cause });
  const result = serializeDiagnosticError(error, ['private answer']);
  const json = JSON.stringify(result);
  assert.match(json, /Failed to save/);
  assert.match(json, /thread_1_request_1/);
  assert.match(json, /11000/);
  assert.match(json, /diagnostic-error.test.ts/);
  assert.ok(!json.includes('private answer'));
  assert.ok(!json.includes('sk-test-secret'));
  assert.ok(!json.includes('abc123'));
  assert.ok(!json.includes('keyValue'));
});

test('handles validation errors, non-Error exceptions and circular causes', () => {
  const validation = Object.assign(new Error('Validation failed'), {
    errors: { outputTokens: new Error('Cast to Number failed for value "private answer" at path outputTokens') },
  }
  );
  validation.cause = validation;
  const json = JSON.stringify(serializeDiagnosticError(validation));
  assert.match(json, /outputTokens/);
  assert.match(json, /Cast to Number failed/);
  assert.match(json, /TruncatedCause/);
  assert.ok(!json.includes('private answer'));
  assert.match(JSON.stringify(serializeDiagnosticError('request failed sk-abc123')), /request failed/);
  assert.ok(!JSON.stringify(serializeDiagnosticError('request failed sk-abc123')).includes('sk-abc123'));
});

test('correlates stages and full errors with request id and pinpoints persistence failures', async () => {
  const logs: Array<Record<string, unknown>> = [];
  const logger = {
    info: (fields: Record<string, unknown>) => {
      logs.push(fields);
    },
    error: (fields: Record<string, unknown>) => {
      logs.push(fields);
    },
  } as never;
  const trace = new AiTrace(logger, { requestId: 'request-1' }, 'private prompt');
  await withAiTrace(trace, async () => {
    await aiStep('model.generate', async () => 'answer');
    try {
      await aiStep('message.assistant.save', async () => {
        throw Object.assign(new Error('E11000 private prompt'), { code: 11000 });
      });
    } catch (error) {
      trace.fail(error);
    }
  });
  assert.ok(logs.every((line) => line.requestId === 'request-1'));
  assert.equal(logs.at(-1)?.stage, 'message.assistant.save');
  assert.match(JSON.stringify(logs.at(-1)), /E11000/);
  assert.match(JSON.stringify(logs.at(-1)), /stack/);
  assert.ok(!JSON.stringify(logs).includes('private prompt'));
});

test('concurrent requests keep trace context and sensitive values isolated', async () => {
  const logs: Array<Record<string, unknown>> = [];
  const logger = {
    info: (fields: Record<string, unknown>) => {
      logs.push(fields);
    },
    error: () => {},
  } as never;
  await Promise.all(
    ['request-a', 'request-b'].map((requestId) => {
      return withAiTrace(new AiTrace(logger, { requestId }, ''), async () => {
        await aiStep(requestId, async () => {
          await Promise.resolve();
        });
      });
    }),
  );
  assert.ok(logs.every((line) => String(line.stage).startsWith(String(line.requestId))));
});
