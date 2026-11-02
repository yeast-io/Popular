import assert from 'node:assert/strict';
import test from 'node:test';
import { ClaudeLlmAdapter } from './claude-llm.adapter.js';
import type { ExternalRequestEventInput } from '../../modules/external-usage/external-usage.types.js';
import { LlmProviderError } from '../../modules/llm/llm.errors.js';

function response(stop = 'end_turn', complete = true, text = '你好'): Response {
  const events = [
    { type: 'message_start', message: { model: 'claude-sonnet-5-5', usage: { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 4, cache_creation_input_tokens: 2 } } },
    { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'hidden' } },
    { type: 'content_block_delta', delta: { type: 'text_delta', text } },
    { type: 'message_delta', delta: { stop_reason: stop }, usage: { output_tokens: 2 } },
    ...(complete ? [{ type: 'message_stop' }] : []),
  ];
  const bytes = new TextEncoder().encode(events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join(''));
  return new Response(new ReadableStream({ start(controller) {
    // Split every byte, including multi-byte Chinese characters and SSE delimiters.
    for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
    controller.close();
  } }), { headers: { 'content-type': 'text/event-stream' } });
}

test('maps system/messages/schema, handles split UTF-8 frames, and records total/cache usage once', async () => {
  let body: Record<string, unknown> = {};
  const records: ExternalRequestEventInput[] = [];
  const client = new ClaudeLlmAdapter('claude-sonnet-5-5', {
    provider: 'claude', apiKey: 'private', timeoutMs: 30_000,
    fetch: async (url, options) => {
      assert.equal(url, 'https://api.anthropic.com/v1/messages');
      assert.equal(new Headers(options?.headers).get('x-api-key'), 'private');
      body = JSON.parse(String(options?.body));
      return response('end_turn', true, '{"answer":"你好"}');
    },
  }, { ownerId: 'alice', recorder: { record: async (event) => { records.push(event); } } });
  const result = await client.generate({
    messages: [{ role: 'system', content: 'system' }, { role: 'user', content: 'user' }],
    maxOutputTokens: 128_000, outputSchema: { name: 'test', schema: { type: 'object' } },
    operation: 'preference.update',
  });
  assert.deepEqual(result, { content: '{"answer":"你好"}', inputTokens: 16, outputTokens: 2 });
  assert.equal(body.system, 'system');
  assert.equal(body.stream, true);
  assert.equal(body.max_tokens, 128_000);
  assert.deepEqual(body.messages, [{ role: 'user', content: 'user' }]);
  assert.deepEqual(body.output_config, { format: { type: 'json_schema', schema: { type: 'object' } } });
  assert.equal(records.length, 1);
  assert.equal(records[0]?.provider, 'claude');
  assert.equal(records[0]?.tokenUsage?.cachedInputTokens, 4);
});

test('structured prose and refusals are failed paid attempts with usage retained', async () => {
  for (const stop of ['end_turn', 'refusal']) {
    const records: ExternalRequestEventInput[] = [];
    const client = new ClaudeLlmAdapter('claude-sonnet-5-5', {
      provider: 'claude', apiKey: 'private', timeoutMs: 30_000,
      fetch: async () => response(stop),
    }, { ownerId: 'alice', recorder: { record: async (event) => { records.push(event); } } });
    await assert.rejects(client.generate({ messages: [], maxOutputTokens: 256,
      operation: 'assistant.intent', outputSchema: { name: 'intent', schema: { type: 'object' } },
    }), (error: unknown) => {
      assert.ok(error instanceof LlmProviderError);
      assert.equal(error.diagnostics?.reason, stop === 'refusal' ? 'refusal' : 'invalid_json');
      return true;
    });
    assert.equal(records.length, 1);
    assert.equal(records[0]?.outcome, 'failure');
    assert.equal(records[0]?.tokenUsage?.outputTokens, 2);
  }
});

test('truncation, refusal, interrupted streams and HTTP authentication cannot become successful preferences', async () => {
  for (const [stop, complete] of [['max_tokens', true], ['refusal', true], ['end_turn', false]] as const) {
    const records: ExternalRequestEventInput[] = [];
    const client = new ClaudeLlmAdapter('claude-sonnet-5-5', {
      provider: 'claude', apiKey: 'private', timeoutMs: 30_000, fetch: async () => response(stop, complete),
    }, { ownerId: 'alice', recorder: { record: async (event) => { records.push(event); } } });
    await assert.rejects(client.generate({ messages: [], maxOutputTokens: 100 }));
    assert.equal(records[0]?.outcome, 'failure');
  }
  const client = new ClaudeLlmAdapter('claude-sonnet-5-5', {
    provider: 'claude', apiKey: 'private', timeoutMs: 30_000,
    fetch: async () => new Response('sensitive upstream body', { status: 401 }),
  });
  await assert.rejects(client.generate({ messages: [], maxOutputTokens: 100 }), { code: 'AI_AUTH_FAILED' });
});
