import assert from 'node:assert/strict';
import test from 'node:test';
import { FormatRegistry } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { AppendConversationMessageRequestSchema, ConversationMessageSchema, ConversationParamsSchema, ConversationTurnStreamEventSchema, RunConversationTurnRequestSchema } from './conversation.schema.js';

FormatRegistry.Set('date-time', (value) => !Number.isNaN(Date.parse(value)));

test('conversation contracts accept bounded user messages and MongoDB ids', () => {
  assert.equal(Value.Check(ConversationParamsSchema, { threadId: '507f1f77bcf86cd799439011' }), true);
  assert.equal(
    Value.Check(AppendConversationMessageRequestSchema, {
      content: 'Recommend a science-fiction movie',
      clientRequestId: 'request-1',
    }
    ),
    true
  );
  assert.equal(Value.Check(AppendConversationMessageRequestSchema, { content: '', role: 'assistant' }), false);
  assert.equal(
    Value.Check(RunConversationTurnRequestSchema, {
      content: 'Continue the conversation',
      clientRequestId: 'turn-1',
    }),
    true
  );
  assert.equal(Value.Check(RunConversationTurnRequestSchema, { content: 'Missing idempotency key' }), false);
});

test('stream events distinguish deltas from durable completion', () => {
  assert.equal(
    Value.Check(ConversationTurnStreamEventSchema, {
      type: 'delta',
      delta: 'partial text',
    }),
    true
  );
  assert.equal(
    Value.Check(ConversationTurnStreamEventSchema, {
      type: 'completed',
      assistantMessage: {
        id: '507f1f77bcf86cd799439012',
        threadId: '507f1f77bcf86cd799439011',
        sequence: 2,
        role: 'assistant',
        content: 'complete text',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      usage: { inputTokens: 10, outputTokens: 2 },
    }
    ),
    true
  );
  assert.equal(
    Value.Check(ConversationTurnStreamEventSchema, {
      type: 'completed',
      usage: { inputTokens: 10, outputTokens: 2 },
    }),
    false
  );
});

test('conversation responses require positive sequence numbers and ISO timestamps', () => {
  const base = {
    id: '507f1f77bcf86cd799439012',
    threadId: '507f1f77bcf86cd799439011',
    role: 'user',
    content: 'hello',
    createdAt: '2026-01-01T00:00:00.000Z',
  };
  assert.equal(Value.Check(ConversationMessageSchema, { ...base, sequence: 1 }), true);
  assert.equal(Value.Check(ConversationMessageSchema, { ...base, sequence: 0 }), false);
});
