import assert from 'node:assert/strict';
import test from 'node:test';
import { AssistantAgent } from './assistant.agent.js';
import { ASSISTANT_INTENT_SYSTEM_PROMPT } from '../../../config/system-prompts.js';
import type { LlmGenerateInput } from '../../llm/llm.types.js';
import type { AssistantInputWorkflowMessage } from '../assistant.type.js';

const input: AssistantInputWorkflowMessage = { ownerId: 'alice', channel: 'telegram', chatId: '101',
  messageId: '2', text: 'The second one', receivedAt: '2026-10-18T00:00:00.000Z' };
const options = { systemPrompt: 'Be concise.', maxContextTokens: 8_000, maxOutputTokens: 500 };

test('personal assistant detects intent using the latest message and conversation context in separate roles', async () => {
  let request: LlmGenerateInput | undefined;
  const agent = new AssistantAgent({ generate: async value => {
    request = value;
    return { content: '{"intent":"download"}', inputTokens: 1, outputTokens: 1 };
  } }, options);
  const history = [{ role: 'assistant' as const, content: 'Which release would you like to download?' }];
  assert.equal((await agent.run(input, history)).intent, 'download');
  assert.deepEqual(request!.messages, [
    { role: 'system', content: ASSISTANT_INTENT_SYSTEM_PROMPT }, ...history, { role: 'user', content: input.text },
  ]);
  assert.equal(request!.outputSchema!.schema.additionalProperties, false);
  assert.ok(!JSON.stringify(request).includes(input.ownerId));
});

test('only the five supported intents are accepted, including explicit unclear results', async () => {
  for (const intent of ['discuss', 'recommend', 'resources', 'download', 'unclear']) {
    const agent = new AssistantAgent({ generate: async () => ({ content: JSON.stringify({ intent }), inputTokens: 1, outputTokens: 1 }) }, options);
    assert.equal((await agent.run(input)).intent, intent);
  }
});

test('malformed, unknown, and extra model output fields fail instead of being routed', async () => {
  for (const content of ['not json', '{"intent":"execute"}', '{"intent":"download","confirmed":true}', '{}']) {
    const agent = new AssistantAgent({ generate: async () => ({ content, inputTokens: 1, outputTokens: 1 }) }, options);
    await assert.rejects(agent.run(input));
  }
});

test('provider failures propagate and cancellation discards late classification results', async () => {
  const failed = new AssistantAgent({ generate: async () => { throw new Error('upstream failure'); } }, options);
  await assert.rejects(failed.run(input), /upstream failure/);
  const controller = new AbortController();
  const agent = new AssistantAgent({ generate: async request => {
    assert.equal(request.signal, controller.signal);
    controller.abort();
    return { content: '{"intent":"download"}', inputTokens: 1, outputTokens: 1 };
  } }, options);
  await assert.rejects(agent.run(input, [], controller.signal), { name: 'AbortError' });
});

test('the same personal assistant detects an intent and handles the discussion response', async () => {
  const requests: LlmGenerateInput[] = [];
  const agent = new AssistantAgent({ generate: async request => {
    requests.push(request);
    return { content: requests.length === 1 ? '{"intent":"discuss"}' : 'A general conversation reply.', inputTokens: 1, outputTokens: 1 };
  } }, options);
  assert.deepEqual(await agent.run(input), { intent: 'discuss', replyText: 'A general conversation reply.' });
  assert.ok(requests[0]!.outputSchema);
  assert.equal(requests[1]!.outputSchema, undefined);
  assert.equal(requests[1]!.maxOutputTokens, options.maxOutputTokens);
});

test('unavailable capabilities and clarification only call the model to classify the request', async () => {
  for (const intent of ['recommend', 'resources', 'download', 'unclear'] as const) {
    let calls = 0;
    const agent = new AssistantAgent({ generate: async () => {
      calls++;
      return { content: JSON.stringify({ intent }), inputTokens: 1, outputTokens: 1 };
    } }, options);
    const result = await agent.run(input);
    assert.equal(calls, 1);
    assert.equal(result.intent, intent);
    assert.match(result.replyText, intent === 'unclear' ? /补充/ : /尚未接通/);
  }
});

test('discussion rejects empty responses and discards late results after cancellation', async () => {
  const empty = new AssistantAgent({ generate: async request => ({
    content: request.outputSchema ? '{"intent":"discuss"}' : '  ', inputTokens: 1, outputTokens: 0,
  }) }, options);
  await assert.rejects(empty.run(input), /empty reply/);
  const controller = new AbortController();
  const agent = new AssistantAgent({ generate: async request => {
    if (request.outputSchema) return { content: '{"intent":"discuss"}', inputTokens: 1, outputTokens: 1 };
    controller.abort(); return { content: 'Late response', inputTokens: 1, outputTokens: 1 };
  } }, options);
  await assert.rejects(agent.run(input, [], controller.signal), { name: 'AbortError' });
});
