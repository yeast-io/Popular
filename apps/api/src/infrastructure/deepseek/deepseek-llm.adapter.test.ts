import assert from 'node:assert/strict';
import test from 'node:test';
import type OpenAI from 'openai';
import { DeepSeekLlmAdapter } from './deepseek-llm.adapter.js';
import type { ExternalRequestEventInput } from '../../modules/external-usage/external-usage.types.js';
import { LlmProviderError } from '../../modules/llm/llm.errors.js';

test('invalid structured output is attributed to DeepSeek and retains failed request usage', async () => {
  const records: ExternalRequestEventInput[] = [];
  const sdk = { responses: { create: async () => ({
    output_text: 'I cannot provide that.', status: 'completed', usage: { input_tokens: 12, output_tokens: 5 },
  }) } } as unknown as Pick<OpenAI, 'responses'>;
  const adapter = new DeepSeekLlmAdapter(sdk, 'deepseek-flash', {
    ownerId: 'alice', recorder: { record: async (event) => { records.push(event); } },
  });
  await assert.rejects(adapter.generate({ messages: [], maxOutputTokens: 256,
    outputSchema: { name: 'intent', schema: { type: 'object' } }, operation: 'assistant.intent',
  }), (error: unknown) => {
    assert.ok(error instanceof LlmProviderError);
    assert.equal(error.diagnostics?.provider, 'deepseek');
    assert.equal(error.diagnostics?.reason, 'invalid_json');
    return true;
  });
  assert.equal(records.length, 1);
  assert.equal(records[0]?.outcome, 'failure');
  assert.equal(records[0]?.tokenUsage?.outputTokens, 5);
});

test('official Responses compatibility preserves strict JSON and attributes usage to DeepSeek', async () => {
  let payload: Record<string, unknown> = {};
  const records: ExternalRequestEventInput[] = [];
  const sdk = { responses: { create: async (input: Record<string, unknown>) => {
    payload = input;
    return { output_text: '{"changes":[]}', status: 'completed', usage: { input_tokens: 12, output_tokens: 5 } };
  } } } as unknown as Pick<OpenAI, 'responses'>;
  const adapter = new DeepSeekLlmAdapter(sdk, 'deepseek-flash', {
    ownerId: 'alice', recorder: { record: async (event) => { records.push(event); } },
  });
  const result = await adapter.generate({ messages: [{ role: 'user', content: 'test' }], maxOutputTokens: 393_216,
    outputSchema: { name: 'preferences', schema: { type: 'object' } }, operation: 'preference.update' });
  assert.equal(result.content, '{"changes":[]}');
  assert.equal(payload.max_output_tokens, 393_216);
  assert.equal(payload.store, false);
  assert.deepEqual(payload.text, { format: { type: 'json_schema', name: 'preferences', schema: { type: 'object' }, strict: true } });
  assert.equal('provider' in payload, false);
  assert.equal(records[0]?.provider, 'deepseek');
  assert.equal(records[0]?.operation, 'preference.update');
});
