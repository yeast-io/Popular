import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import { AiTrace, withAiTrace } from '../../infrastructure/logging/ai-trace.js';
import { LlmProviderError } from './llm.errors.js';
import { parseLlmOutput } from './llm-output.schema.js';

test('invalid output logs safe correlated diagnostics even with verbose tracing disabled', () => {
  for (const content of ['坦白说，我这边没法向 private payload', '{"intent":"private payload"}']) {
    const logs: unknown[] = [];
    const trace = new AiTrace({ error: (fields: unknown) => {
      logs.push(fields);
    } },
    { correlationId: 'job-test' }, '', 'assistant.job', false);
    assert.throws(() => withAiTrace(trace, () => parseLlmOutput(z.object({ intent: z.literal('download') }), content, {
      reason: 'invalid_json', provider: 'openai', model: 'test-model', operation: 'assistant.intent', schemaName: 'intent',
    })), (error: unknown) => {
      assert.ok(error instanceof LlmProviderError);
      assert.ok(error.cause instanceof Error);
      assert.match(error.cause.stack!, /parseLlm/);
      return true;
    });
    assert.equal(logs.length, 1);
    const output = JSON.stringify(logs);
    assert.match(output, /job-test/);
    assert.match(output, /assistant.intent/);
    assert.match(output, /test-model/);
    assert.ok(!output.includes('private payload'));
    assert.ok(!output.includes('坦白说'));
  }
});
