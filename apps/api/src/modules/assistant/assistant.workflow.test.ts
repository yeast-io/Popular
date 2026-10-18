import { ASSISTANT_INTENT_SYSTEM_PROMPT } from '../../config/system-prompts/assistant.prompts.js';
import type { PreferenceService } from '../preferences/preference.service.js';
import type { LlmClient } from '../llm/llm.types.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { AssistantWorkflow } from './assistant.workflow.js';
import type { AssistantInputWorkflowMessage } from './assistant.types.js';
import type { LlmGenerateInput } from '../llm/llm.types.js';

const input: AssistantInputWorkflowMessage = { ownerId: 'alice', channel: 'telegram', chatId: '101',
  messageId: '1', text: 'What do you think of Spider-Man?', receivedAt: '2026-10-18T00:00:00.000Z' };
const options = { systemPrompt: 'Be concise.', maxContextTokens: 8_000, maxOutputTokens: 500 };

test('web workflow can defer discussion to the existing streaming path after classification', async () => {
  let calls = 0;
  const workflow = new AssistantWorkflow(async () => ({ generate: async () => {
    calls++;
    return { content: '{"intent":"discuss","preferenceSignal":"none"}', inputTokens: 1, outputTokens: 1 };
  } }), { ...options, deferDiscussion: true });
  assert.deepEqual(await workflow.run({ ...input, channel: 'web' }), { intent: 'discuss', replyText: '' });
  assert.equal(calls, 1);
});

test('discussion routes through the graph using the owner client and bounded chat history', async () => {
  const owners: string[] = []; const requests: LlmGenerateInput[] = [];
  const runner = new AssistantWorkflow(async ownerId => {
    owners.push(ownerId);
    return { generate: async request => {
      requests.push(request);
      return { content: requests.length === 1 ? '{"intent":"discuss"}' : 'Which Spider-Man movie?', inputTokens: 1, outputTokens: 1 };
    } };
  }, options);
  const result = await runner.run(input, [{ role: 'user', content: 'I like animation.' }]);
  assert.deepEqual(result, { intent: 'discuss', replyText: 'Which Spider-Man movie?' });
  assert.deepEqual(owners, ['alice']);
  assert.equal(requests.length, 2);
  assert.ok(requests[0]!.outputSchema);
  assert.equal(requests[1]!.messages.at(-1)!.content, input.text);
  assert.ok(requests[1]!.messages.some(message => message.content === 'I like animation.'));
});

for (const intent of ['recommend', 'resources', 'download', 'unclear'] as const) {
  test(`${intent} routes to an explicit placeholder without invoking business actions`, async () => {
    let calls = 0;
    const runner = new AssistantWorkflow(async () => ({ generate: async () => {
      calls++; return { content: JSON.stringify({ intent }), inputTokens: 1, outputTokens: 1 };
    } }), options);
    const result = await runner.run(input);
    assert.equal(result.intent, intent);
    assert.equal(calls, 1);
    assert.match(result.replyText, intent === 'unclear' ? /补充/ : /尚未接通/);
  });
}

test('invalid classifier output fails instead of becoming unclear', async () => {
  const runner = new AssistantWorkflow(async () => ({ generate: async () => ({
    content: '{"intent":"execute_shell"}', inputTokens: 1, outputTokens: 1,
  }) }), options);
  await assert.rejects(runner.run(input));
});

test('invalid input is rejected before key resolution or model calls', async () => {
  let called = false;
  const runner = new AssistantWorkflow(async () => { called = true; throw new Error(); }, options);
  await assert.rejects(runner.run({ ...input, text: '  ' }));
  assert.equal(called, false);
});

test('oversized context is rejected and pre-aborted runs never call the model', async () => {
  let calls = 0;
  const runner = new AssistantWorkflow(async () => ({ generate: async () => {
    calls++; throw new Error('Should not reach the provider');
  } }), { ...options, maxContextTokens: 1_024 });
  await assert.rejects(runner.run({ ...input, text: '电影'.repeat(1_000) }), /context budget/);
  await assert.rejects(runner.run(input, [], AbortSignal.abort()));
  assert.equal(calls, 0);
});

function createWorkflow(llm: Pick<LlmClient, 'generate'>, config: ConstructorParameters<typeof AssistantWorkflow>[1]) {
  return new AssistantWorkflow(async () => llm, config);
}

const routingInput: AssistantInputWorkflowMessage = { ownerId: 'alice', channel: 'telegram', chatId: '101',
  messageId: '2', text: 'The second one', receivedAt: '2026-10-18T00:00:00.000Z' };
const routingOptions = { systemPrompt: 'Be concise.', maxContextTokens: 8_000, maxOutputTokens: 500 };

test('long-term evidence is independent of primary intent and maintenance failure does not block the reply', async () => {
  let scheduled = false, reported = false;
  const preferences = { chatEvidence: async (ownerId: string, _event: string, text: string) => {
    assert.equal(ownerId, 'alice'); assert.equal(text, routingInput.text); scheduled = true; throw new Error('queue unavailable');
  }, store: { read: async () => ({ entries: [] }) } } as unknown as PreferenceService;
  const agent = createWorkflow({ generate: async request => ({ content: request.outputSchema
    ? '{"intent":"discuss","preferenceSignal":"explicit"}' : 'Reply still works', inputTokens: 1, outputTokens: 1 }) },
  { ...routingOptions, preferences, report: () => { reported = true; } });
  assert.equal((await agent.run(routingInput)).replyText, 'Reply still works');
  assert.ok(scheduled && reported);
});

test('personal assistant detects intent using the latest message and conversation context in separate roles', async () => {
  let request: LlmGenerateInput | undefined;
  const agent = createWorkflow({ generate: async value => {
    request = value;
    return { content: '{"intent":"download"}', inputTokens: 1, outputTokens: 1 };
  } }, routingOptions);
  const history = [{ role: 'assistant' as const, content: 'Which release would you like to download?' }];
  assert.equal((await agent.run(routingInput, history)).intent, 'download');
  assert.deepEqual(request!.messages, [
    { role: 'system', content: ASSISTANT_INTENT_SYSTEM_PROMPT }, ...history, { role: 'user', content: routingInput.text },
  ]);
  assert.equal(request!.outputSchema!.schema.additionalProperties, false);
  assert.ok(!JSON.stringify(request).includes(routingInput.ownerId));
});

test('only the five supported intents are accepted, including explicit unclear results', async () => {
  for (const intent of ['discuss', 'recommend', 'resources', 'download', 'unclear']) {
    const agent = createWorkflow({ generate: async () => ({ content: JSON.stringify({ intent }), inputTokens: 1, outputTokens: 1 }) }, routingOptions);
    assert.equal((await agent.run(routingInput)).intent, intent);
  }
});

test('malformed, unknown, and extra model output fields fail instead of being routed', async () => {
  for (const content of ['not json', '{"intent":"execute"}', '{"intent":"download","confirmed":true}', '{}']) {
    const agent = createWorkflow({ generate: async () => ({ content, inputTokens: 1, outputTokens: 1 }) }, routingOptions);
    await assert.rejects(agent.run(routingInput));
  }
});

test('provider failures propagate and cancellation discards late classification results', async () => {
  const failed = createWorkflow({ generate: async () => { throw new Error('upstream failure'); } }, routingOptions);
  await assert.rejects(failed.run(routingInput), /upstream failure/);
  const controller = new AbortController();
  const agent = createWorkflow({ generate: async request => {
    assert.equal(request.signal, controller.signal);
    controller.abort();
    return { content: '{"intent":"download"}', inputTokens: 1, outputTokens: 1 };
  } }, routingOptions);
  await assert.rejects(agent.run(routingInput, [], controller.signal), { name: 'AbortError' });
});

test('the same personal assistant detects an intent and handles the discussion response', async () => {
  const requests: LlmGenerateInput[] = [];
  const agent = createWorkflow({ generate: async request => {
    requests.push(request);
    return { content: requests.length === 1 ? '{"intent":"discuss"}' : 'A general conversation reply.', inputTokens: 1, outputTokens: 1 };
  } }, routingOptions);
  assert.deepEqual(await agent.run(routingInput), { intent: 'discuss', replyText: 'A general conversation reply.' });
  assert.ok(requests[0]!.outputSchema);
  assert.equal(requests[1]!.outputSchema, undefined);
  assert.equal(requests[1]!.maxOutputTokens, routingOptions.maxOutputTokens);
});

test('unavailable capabilities and clarification only call the model to classify the request', async () => {
  for (const intent of ['recommend', 'resources', 'download', 'unclear'] as const) {
    let calls = 0;
    const agent = createWorkflow({ generate: async () => {
      calls++;
      return { content: JSON.stringify({ intent }), inputTokens: 1, outputTokens: 1 };
    } }, routingOptions);
    const result = await agent.run(routingInput);
    assert.equal(calls, 1);
    assert.equal(result.intent, intent);
    assert.match(result.replyText, intent === 'unclear' ? /补充/ : /尚未接通/);
  }
});

test('discussion rejects empty responses and discards late results after cancellation', async () => {
  const empty = createWorkflow({ generate: async request => ({
    content: request.outputSchema ? '{"intent":"discuss"}' : '  ', inputTokens: 1, outputTokens: 0,
  }) }, routingOptions);
  await assert.rejects(empty.run(routingInput), /empty reply/);
  const controller = new AbortController();
  const agent = createWorkflow({ generate: async request => {
    if (request.outputSchema) return { content: '{"intent":"discuss"}', inputTokens: 1, outputTokens: 1 };
    controller.abort(); return { content: 'Late response', inputTokens: 1, outputTokens: 1 };
  } }, routingOptions);
  await assert.rejects(agent.run(routingInput, [], controller.signal), { name: 'AbortError' });
});
