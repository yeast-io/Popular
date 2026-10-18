import assert from 'node:assert/strict';
import test from 'node:test';
import type OpenAI from 'openai';
import { LlmProviderError } from '../../modules/llm/llm.types.js';
import { OpenAILlmClient } from './client.js';

test('maps messages to a non-persisted Responses API request and returns usage', async () => {
  let request: unknown;
  const openai = {
    responses: {
      create: async (input: unknown) => {
        request = input;
        return {
          output_text: 'Use the existing conversation context.',
          usage: { input_tokens: 42, output_tokens: 8 },
        };
      },
    },
  } as unknown as Pick<OpenAI, 'responses'>;
  const client = new OpenAILlmClient(openai, 'test-model');

  const result = await client.generate({
    messages: [
      { role: 'system', content: 'Be concise.' },
      { role: 'user', content: 'Recommend a film.' },
    ],
    maxOutputTokens: 500,
  });

  assert.deepEqual(request, {
    model: 'test-model',
    input: [
      { role: 'system', content: 'Be concise.' },
      { role: 'user', content: 'Recommend a film.' },
    ],
    max_output_tokens: 500,
    store: false,
  });
  assert.deepEqual(result, {
    content: 'Use the existing conversation context.',
    inputTokens: 42,
    outputTokens: 8,
  });
});

test('sanitizes provider failures and empty output', async () => {
  const failed = new OpenAILlmClient({
    responses: { create: async () => { throw new Error('secret upstream detail'); } },
  } as unknown as Pick<OpenAI, 'responses'>, 'test-model');
  await assert.rejects(failed.generate({ messages: [], maxOutputTokens: 10 }), LlmProviderError);

  const empty = new OpenAILlmClient({
    responses: { create: async () => ({ output_text: ' ', usage: { input_tokens: 1, output_tokens: 0 } }) },
  } as unknown as Pick<OpenAI, 'responses'>, 'test-model');
  await assert.rejects(empty.generate({ messages: [], maxOutputTokens: 10 }), LlmProviderError);
});

test('classification uses a strict JSON schema and rejects incomplete output', async () => {
  let request: Record<string, unknown> = {};
  let status = 'completed';
  const client = new OpenAILlmClient({ responses: { create: async (input: Record<string, unknown>) => {
    request = input;
    return { status, output_text: '{"intent":"discuss"}', usage: { input_tokens: 1, output_tokens: 1 } };
  } } } as unknown as Pick<OpenAI, 'responses'>, 'test-model');
  const input = { messages: [], maxOutputTokens: 256, outputSchema: { name: 'intent', schema: { type: 'object' } } };
  await client.generate(input);
  assert.deepEqual(request.text, { format: { type: 'json_schema', name: 'intent', schema: { type: 'object' }, strict: true } });
  assert.equal(request.store, false);
  status = 'incomplete';
  await assert.rejects(client.generate(input), LlmProviderError);
});

test('maps Responses API text deltas and completion usage', async () => {
  let request: unknown;
  const events = async function* () {
    yield { type: 'response.created' };
    yield { type: 'response.output_text.delta', delta: 'Hello' };
    yield { type: 'response.refusal.delta', delta: ' world' };
    yield {
      type: 'response.completed',
      response: { usage: { input_tokens: 11, output_tokens: 2 } },
    };
  };
  const openai = {
    responses: {
      create: async (input: unknown) => {
        request = input;
        return events();
      },
    },
  } as unknown as Pick<OpenAI, 'responses'>;
  const client = new OpenAILlmClient(openai, 'test-model');

  const result = [];
  for await (const event of client.stream({
    messages: [{ role: 'user', content: 'Say hello.' }],
    maxOutputTokens: 20,
  })) result.push(event);

  assert.deepEqual(request, {
    model: 'test-model',
    input: [{ role: 'user', content: 'Say hello.' }],
    max_output_tokens: 20,
    store: false,
    stream: true,
  });
  assert.deepEqual(result, [
    { type: 'delta', delta: 'Hello' },
    { type: 'delta', delta: ' world' },
    { type: 'completed', inputTokens: 11, outputTokens: 2 },
  ]);
});

test('rejects a stream that ends without a completed event', async () => {
  const openai = {
    responses: { create: async () => (async function* () {
      yield { type: 'response.output_text.delta', delta: 'partial' };
    })() },
  } as unknown as Pick<OpenAI, 'responses'>;
  const client = new OpenAILlmClient(openai, 'test-model');

  await assert.rejects(async () => {
    for await (const _event of client.stream({ messages: [], maxOutputTokens: 10 })) {
      // Consume the stream to surface completion validation.
    }
  }, LlmProviderError);
});

test('returns sanitized actionable errors for authentication, quota and rate limits', async () => {
  for (const [status, code, expected] of [
    [401, 'invalid_api_key', 'OPENAI_AUTH_FAILED'],
    [403, 'permission_denied', 'OPENAI_AUTH_FAILED'],
    [429, 'insufficient_quota', 'OPENAI_QUOTA_EXCEEDED'],
    [429, 'rate_limit_exceeded', 'OPENAI_RATE_LIMITED'],
  ] as const) {
    const client = new OpenAILlmClient({ responses: { create: async () => {
      throw Object.assign(new Error('secret key sk-private'), { status, code });
    } } } as unknown as Pick<OpenAI, 'responses'>, 'test-model');
    const check = (error: unknown) => {
      assert.equal((error as { code: string }).code, expected);
      assert.ok(!(error as Error).message.includes('sk-private'));
      return true;
    };
    await assert.rejects(client.generate({ messages: [], maxOutputTokens: 10 }), check);
    await assert.rejects(async () => {
      for await (const _event of client.stream({ messages: [], maxOutputTokens: 10 })) { /* consume */ }
    }, check);
  }
});

test('retains only safe diagnostic metadata for each stream failure', async () => {
  const cases = [
    { events: [{ type: 'response.output_text.delta', delta: 'private chat text' }], reason: 'missing_completion', lastEventType: 'response.output_text.delta' },
    { events: [{ type: 'response.completed', response: { id: 'resp_test123', usage: null } }], reason: 'missing_usage', lastEventType: 'response.completed' },
    { events: [{ type: 'response.incomplete', response: { id: 'resp_test123', incomplete_details: { reason: 'max_output_tokens' }, output: 'private chat text' } }], reason: 'terminal_failure', lastEventType: 'response.incomplete', incompleteReason: 'max_output_tokens' },
    { events: [{ type: 'response.failed', response: { id: 'resp_test123', error: { code: 'server_error', message: 'secret key and chat text' } } }], reason: 'terminal_failure', lastEventType: 'response.failed', upstreamCode: 'server_error' },
    { events: [{ type: 'error', code: 'secret-key', message: 'private chat text' }], reason: 'terminal_failure', lastEventType: 'error' },
  ];
  for (const scenario of cases) {
    const client = new OpenAILlmClient({ responses: { create: async () => (async function* () {
      for (const event of scenario.events) yield event;
    })() } } as unknown as Pick<OpenAI, 'responses'>, 'test-model');
    await assert.rejects(async () => {
      for await (const _event of client.stream({ messages: [], maxOutputTokens: 10 })) { /* consume */ }
    }, (error: unknown) => {
      assert.ok(error instanceof LlmProviderError);
      assert.equal(error.diagnostics?.reason, scenario.reason);
      assert.equal(error.diagnostics?.lastEventType, scenario.lastEventType);
      if ('incompleteReason' in scenario) assert.equal(error.diagnostics?.incompleteReason, scenario.incompleteReason);
      if ('upstreamCode' in scenario) assert.equal(error.diagnostics?.upstreamCode, scenario.upstreamCode);
      const serialized = JSON.stringify(error.diagnostics);
      assert.ok(!serialized.includes('secret'));
      assert.ok(!serialized.includes('private chat'));
      return true;
    });
  }
});

test('records safe HTTP status and upstream request id without raw exception details', async () => {
  const client = new OpenAILlmClient({ responses: { create: async () => {
    throw Object.assign(new Error('secret key and private chat text'), { status: 500, code: 'server_error', request_id: 'req_test123' });
  } } } as unknown as Pick<OpenAI, 'responses'>, 'test-model');
  await assert.rejects(async () => {
    for await (const _event of client.stream({ messages: [], maxOutputTokens: 10 })) { /* consume */ }
  }, (error: unknown) => {
    assert.ok(error instanceof LlmProviderError);
    assert.deepEqual(error.diagnostics, {
      reason: 'upstream_exception', receivedText: false, upstreamStatus: 500,
      upstreamCode: 'server_error', upstreamRequestId: 'req_test123',
    });
    assert.ok(error.cause instanceof Error);
    assert.equal(error.cause.message, 'secret key and private chat text');
    return true;
  });
});
