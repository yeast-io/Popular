import assert from 'node:assert/strict';
import test from 'node:test';
import { AssistantAgent } from './assistant.agent.js';
import type { AssistantInputWorkflowMessage } from '../assistant.types.js';
import type { LlmGenerateInput } from '../../llm/llm.types.js';

const input: AssistantInputWorkflowMessage = { ownerId: 'alice', channel: 'telegram', chatId: '101', messageId: 'm1', text: '我一直喜欢战争片，推荐几部', receivedAt: '2026-10-18T00:00:00.000Z' };
const options = { systemPrompt: 'Be concise.', maxContextTokens: 8000, maxOutputTokens: 500 };

test('assistant agent detects intent and preference evidence without business side effects', async () => {
  let calls = 0;
  const agent = new AssistantAgent({ generate: async () => {
    calls++;
    return { content: '{"intent":"recommend","preferenceSignal":"explicit"}', inputTokens: 1, outputTokens: 1 };
  } }, options);
  assert.deepEqual(await agent.detectIntent(input), { intent: 'recommend', preferenceSignal: 'explicit' });
  assert.equal(calls, 1);
});

test('discussion agent preserves user context and rejects empty model replies', async () => {
  let request: LlmGenerateInput | undefined;
  const agent = new AssistantAgent({ generate: async value => {
    request = value;
    return { content: 'Here is the explanation.', inputTokens: 1, outputTokens: 1 };
  } }, options);
  assert.equal((await agent.discuss(input, [{ role: 'user', content: 'Earlier context' }])).replyText, 'Here is the explanation.');
  assert.ok(request?.messages.some(message => message.content === 'Earlier context'));
  const empty = new AssistantAgent({ generate: async () => ({ content: ' ', inputTokens: 1, outputTokens: 0 }) }, options);
  await assert.rejects(empty.discuss(input), /empty reply/);
});
