import assert from 'node:assert/strict';
import test from 'node:test';
import type OpenAI from 'openai';
import { OpenAILlmClient } from './client.js';
import { readTokenUsage } from './request-accounting.js';
import type { ExternalRequestEventInput } from '../../modules/external-usage/external-usage.types.js';

const input = {
  messages: [{ role: 'user' as const, content: 'private user message' }],
  maxOutputTokens: 256,
  operation: 'assistant.intent' as const,
};
const usage = { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 40 } };

test('each retry is recorded for its owner and model without prompts, output, or credentials', async () => {
  const events: ExternalRequestEventInput[] = [];
  let calls = 0;
  const client = new OpenAILlmClient(
    {
      responses: {
        create: async (_payload: unknown, options: { maxRetries: number }) => {
          assert.equal(options.maxRetries, 0);
          calls++;
          if (calls === 1) throw Object.assign(new Error('secret sk-key'), { status: 429 });
          return { model: 'test-model-snapshot', status: 'completed', output_text: 'private output', usage };
        },
      },
    } as unknown as Pick<OpenAI, 'responses'>,
    'test-model',
    {
      ownerId: 'alice',
      recorder: {
        record: async (event) => {
          events.push(event);
        },
      },
      maxRetries: 1,
      retryDelayMs: 0,
    }
  );
  await client.generate(input);
  assert.equal(calls, 2);
  assert.equal(events.length, 2);
  assert.deepEqual(
    events.map((event) => [event.ownerId, event.operation, event.attempt, event.outcome]),
    [
      ['alice', 'assistant.intent', 1, 'failure'],
      ['alice', 'assistant.intent', 2, 'success'],
    ]
  );
  assert.equal(events[0]!.operationId, events[1]!.operationId);
  assert.equal(events[0]!.tokenUsage, undefined);
  assert.equal(events[0]!.errorCode, 'rate_limited');
  assert.deepEqual(events[1]!.tokenUsage, { inputTokens: 100, outputTokens: 20, cachedInputTokens: 40 });
  assert.equal(events[1]!.model, 'test-model-snapshot');
  assert.ok(!JSON.stringify(events).includes('private'));
  assert.ok(!JSON.stringify(events).includes('sk-key'));
});

test('stream completion, incomplete responses, and disconnects each record exactly one request', async () => {
  for (const type of ['response.completed', 'response.incomplete', 'disconnect'] as const) {
    const events: ExternalRequestEventInput[] = [];
    const client = new OpenAILlmClient(
      {
        responses: {
          create: async () => {
            return (async function* () {
              yield { type: 'response.output_text.delta', delta: 'private output' };
              if (type !== 'disconnect')
                yield {
                  type,
                  response: {
                    id: 'resp_test',
                    model: 'test-model',
                    usage,
                    incomplete_details: { reason: 'max_output_tokens' },
                  },
                };
            })();
          },
        },
      } as unknown as Pick<OpenAI, 'responses'>,
      'test-model',
      {
        ownerId: 'alice',
        recorder: {
          record: async (event) => {
            events.push(event);
          },
        },
      }
    );
    const consume = async () => {
      for await (const _event of client.stream(input)) {
        /* consume */
      }
    };
    if (type === 'response.completed') await consume();
    else await assert.rejects(consume());
    assert.equal(events.length, 1);
    assert.equal(events[0]!.outcome, type === 'response.completed' ? 'success' : 'failure');
    assert.equal(events[0]!.tokenUsage?.inputTokens, type === 'disconnect' ? undefined : 100);
  }
});

test('consumer cancellation records unknown usage and never retries a partially consumed stream', async () => {
  let calls = 0;
  const events: ExternalRequestEventInput[] = [];
  const client = new OpenAILlmClient(
    {
      responses: {
        create: async () => {
          calls++;
          return (async function* () {
            yield { type: 'response.output_text.delta', delta: 'partial' };
          })();
        },
      },
    } as unknown as Pick<OpenAI, 'responses'>,
    'test-model',
    {
      ownerId: 'bob',
      maxRetries: 2,
      recorder: {
        record: async (event) => {
          events.push(event);
        },
      },
    }
  );
  for await (const _event of client.stream(input)) break;
  assert.equal(calls, 1);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.ownerId, 'bob');
  assert.equal(events[0]!.outcome, 'failure');
  assert.equal(events[0]!.tokenUsage, undefined);
});

test('recorder failure does not retry generation; abort before request produces no event', async () => {
  let calls = 0;
  let records = 0;
  const client = new OpenAILlmClient(
    {
      responses: {
        create: async () => {
          calls++;
          return { status: 'completed', model: 'test-model', output_text: 'ok', usage };
        },
      },
    } as unknown as Pick<OpenAI, 'responses'>,
    'test-model',
    {
      ownerId: 'alice',
      recorder: {
        record: async () => {
          records++;
          throw new Error('storage down');
        },
      },
      maxRetries: 2,
    }
  );
  await client.generate(input);
  assert.equal(calls, 1);
  assert.equal(records, 1);
  await assert.rejects(client.generate({ ...input, signal: AbortSignal.abort() }));
  assert.equal(calls, 1);
  assert.equal(records, 1);
});

test('unknown token usage is distinct from reported zero and missing cache details', () => {
  assert.equal(readTokenUsage(null), undefined);
  assert.equal(readTokenUsage({ input_tokens: -1, output_tokens: 0 }), undefined);
  assert.equal(readTokenUsage({ input_tokens: 1 }), undefined);
  assert.deepEqual(readTokenUsage({ input_tokens: 0, output_tokens: 0 }), { inputTokens: 0, outputTokens: 0 });
  assert.deepEqual(readTokenUsage({ ...usage, input_tokens_details: { cached_tokens: 101 } }), {
    inputTokens: 100,
    outputTokens: 20,
  }
  );
});
