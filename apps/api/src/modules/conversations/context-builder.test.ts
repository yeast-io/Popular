import assert from 'node:assert/strict';
import test from 'node:test';
import { buildConversationContext, ContextBudgetExceededError } from './context-builder.js';
import type { ConversationMessage, TokenCounter } from './conversation.types.js';

const counter: TokenCounter = { count: (text) => text.length };
const message = (sequence: number, content: string): ConversationMessage => ({
  id: `message-${sequence}`,
  ownerId: 'owner-1',
  threadId: 'thread-1',
  sequence,
  role: sequence % 2 === 1 ? 'user' : 'assistant',
  content,
  createdAt: new Date(`2026-01-01T00:00:0${sequence}.000Z`),
});

test('context builder keeps the newest messages in chronological order within budget', () => {
  const result = buildConversationContext({
    systemPrompt: 'system',
    messages: [message(1, 'oldest'), message(2, 'middle'), message(3, 'newest')],
    maxContextTokens: 29,
    responseReserveTokens: 5,
    messageOverheadTokens: 1,
  }, counter);

  assert.deepEqual(result.messages, [
    { role: 'system', content: 'system' },
    { role: 'assistant', content: 'middle' },
    { role: 'user', content: 'newest' },
  ]);
  assert.equal(result.usedTokens, 21);
  assert.equal(result.omittedMessageCount, 1);
});

test('context builder rejects a newest message that cannot fit', () => {
  assert.throws(() => buildConversationContext({
    systemPrompt: '',
    messages: [message(1, 'too long')],
    maxContextTokens: 5,
    responseReserveTokens: 0,
  }, counter), ContextBudgetExceededError);
});

test('context builder accounts for response reserve and safety margin', () => {
  const result = buildConversationContext({
    systemPrompt: 's',
    messages: [message(1, '12345'), message(2, '12')],
    maxContextTokens: 15,
    responseReserveTokens: 3,
    safetyMarginTokens: 2,
    messageOverheadTokens: 1,
  }, counter);
  assert.deepEqual(result.messages.map(({ content }) => content), ['s', '12']);
  assert.equal(result.usedTokens, 5);
});
