import assert from 'node:assert/strict';
import test from 'node:test';
import { AssistantWorkflowRunner } from './assistant.runner.js';
import type { AssistantInputWorkflowMessage } from './assistant.type.js';
import type { LlmGenerateInput } from '../llm/llm.types.js';

const input: AssistantInputWorkflowMessage = { ownerId: 'alice', channel: 'telegram', chatId: '101',
  messageId: '1', text: 'What do you think of Spider-Man?', receivedAt: '2026-10-18T00:00:00.000Z' };
const options = { systemPrompt: 'Be concise.', maxContextTokens: 8_000, maxOutputTokens: 500 };

test('discussion routes through the graph using the owner client and bounded chat history', async () => {
  const owners: string[] = []; const requests: LlmGenerateInput[] = [];
  const runner = new AssistantWorkflowRunner(async ownerId => {
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
    const runner = new AssistantWorkflowRunner(async () => ({ generate: async () => {
      calls++; return { content: JSON.stringify({ intent }), inputTokens: 1, outputTokens: 1 };
    } }), options);
    const result = await runner.run(input);
    assert.equal(result.intent, intent);
    assert.equal(calls, 1);
    assert.match(result.replyText, intent === 'unclear' ? /补充/ : /尚未接通/);
  });
}

test('invalid classifier output fails instead of becoming unclear', async () => {
  const runner = new AssistantWorkflowRunner(async () => ({ generate: async () => ({
    content: '{"intent":"execute_shell"}', inputTokens: 1, outputTokens: 1,
  }) }), options);
  await assert.rejects(runner.run(input));
});

test('invalid input is rejected before key resolution or model calls', async () => {
  let called = false;
  const runner = new AssistantWorkflowRunner(async () => { called = true; throw new Error(); }, options);
  await assert.rejects(runner.run({ ...input, text: '  ' }));
  assert.equal(called, false);
});

test('oversized context is rejected and pre-aborted runs never call the model', async () => {
  let calls = 0;
  const runner = new AssistantWorkflowRunner(async () => ({ generate: async () => {
    calls++; throw new Error('Should not reach the provider');
  } }), { ...options, maxContextTokens: 1_024 });
  await assert.rejects(runner.run({ ...input, text: '电影'.repeat(1_000) }), /context budget/);
  await assert.rejects(runner.run(input, [], AbortSignal.abort()));
  assert.equal(calls, 0);
});
