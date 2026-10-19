import assert from 'node:assert/strict';
import test from 'node:test';
import { AssistantAgent } from './assistant.agent.js';
import type { AssistantInputWorkflowMessage } from '../assistant.types.js';
import type { LlmGenerateInput } from '../../llm/llm.types.js';

const input: AssistantInputWorkflowMessage = {
  ownerId: 'alice',
  channel: 'telegram',
  chatId: '101',
  messageId: 'm1',
  text: '我一直喜欢战争片，推荐几部',
  receivedAt: '2026-10-18T00:00:00.000Z',
};
const options = { systemPrompt: 'Be concise.', maxContextTokens: 8000, maxOutputTokens: 500 };

test('assistant agent detects intent and preference evidence without business side effects', async () => {
  let calls = 0;
  const agent = new AssistantAgent(
    {
      generate: async () => {
        calls++;
        return { content: '{"intent":"recommend","preferenceSignal":"explicit"}', inputTokens: 1, outputTokens: 1 };
      },
    },
    options,
  );
  assert.deepEqual(await agent.classifyRequest(input), { intent: 'recommend', preferenceSignal: 'explicit' });
  assert.equal(calls, 1);
});

test('discussion agent preserves user context and rejects empty model replies', async () => {
  let request: LlmGenerateInput | undefined;
  const agent = new AssistantAgent(
    {
      generate: async (value) => {
        request = value;
        return { content: 'Here is the explanation.', inputTokens: 1, outputTokens: 1 };
      },
    },
    options,
  );
  assert.equal(
    (await agent.discuss(input, [{ role: 'user', content: 'Earlier context' }])).replyText,
    'Here is the explanation.',
  );
  assert.ok(request?.messages.some((message) => message.content === 'Earlier context'));
  const empty = new AssistantAgent(
    {
      generate: async () => {
        return { content: ' ', inputTokens: 1, outputTokens: 0 };
      },
    },
    options,
  );
  await assert.rejects(empty.discuss(input), /empty reply/);
});

test('discussion reserves preference context even when old history exceeds the budget', async () => {
  let request: LlmGenerateInput | undefined;
  const agent = new AssistantAgent(
    {
      generate: async (value) => {
        request = value;
        return { content: 'Reply', inputTokens: 1, outputTokens: 1 };
      },
    },
    options,
  );
  await agent.discuss(
    input,
    [{ role: 'user', content: 'Old history '.repeat(2000) }],
    undefined,
    'User preference data: history films',
  );
  assert.ok(request?.messages.some((message) => message.content === 'User preference data: history films'));
  assert.equal(request?.messages.at(-1)?.content, input.text);
  assert.equal(request?.messages.length, 3);
});

test('intent classification validates Chinese/English locale and leaves neutral messages to workflow inheritance', async () => {
  for (const locale of ['zh-CN', 'en-US', null] as const) {
    const agent = new AssistantAgent({ generate: async (request) => {
      assert.ok((request.outputSchema?.schema.required as string[] | undefined)?.includes('locale'));
      return { content: JSON.stringify(
        { intent: 'download', preferenceSignal: 'none', locale }
      ), inputTokens: 1, outputTokens: 1 };
    } }, options);
    const detected = await agent.classifyRequest(input);
    assert.equal(detected.locale, locale ?? undefined);
  }
  const invalid = new AssistantAgent({ generate: async () => {
    return ({
      content: '{"intent":"download","preferenceSignal":"none","locale":"fr-FR"}', inputTokens: 1, outputTokens: 1,
    });
  } }, options);
  await assert.rejects(invalid.classifyRequest(input));
});


test('intent and handling are independent validated decisions', async () => {
  for (const handling of ['answer', 'tool', 'clarify'] as const) {
    const agent = new AssistantAgent({ generate: async (request) => {
      assert.ok((request.outputSchema!.schema.required as string[]).includes('handling'));
      return { content: JSON.stringify(
        { intent: 'download', handling, preferenceSignal: 'none', locale: 'zh-CN' }
      ), inputTokens: 1, outputTokens: 1 };
    } }, options);
    const decision = await agent.classifyRequest(input);
    assert.equal(decision.intent, 'download');
    assert.equal(decision.handling, handling);
  }
  const invalid = new AssistantAgent({ generate: async () => {
    return ({
      content: JSON.stringify({ intent: 'download', handling: 'execute_shell' }), inputTokens: 1, outputTokens: 1,
    });
  } }, options);
  await assert.rejects(invalid.classifyRequest(input));
});
