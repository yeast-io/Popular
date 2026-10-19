import assert from 'node:assert/strict';
import test from 'node:test';
import type { AuthService } from '../auth/auth.service.js';
import { ConversationService } from './conversation.service.js';
import type {
  AppendMessageInput,
  ConversationMessage,
  ConversationStore,
  ConversationThread,
} from './conversation.types.js';

const ownerId = '507f1f77bcf86cd799439011';
const threadId = '507f1f77bcf86cd799439012';
const otherThreadId = '507f1f77bcf86cd799439013';
const now = new Date('2026-01-01T00:00:00.000Z');

class MemoryConversationStore implements ConversationStore {
  readonly threads = new Map<string, ConversationThread>();
  readonly messages: ConversationMessage[] = [];

  async createThread(inputOwnerId: string): Promise<ConversationThread> {
    const thread = {
      id: threadId,
      ownerId: inputOwnerId,
      status: 'active' as const,
      nextSequence: 1,
      createdAt: now,
      updatedAt: now,
    };
    this.threads.set(thread.id, thread);
    return thread;
  }

  async listThreads(inputOwnerId: string, limit: number): Promise<ConversationThread[]> {
    return [...this.threads.values()]
      .filter(({ ownerId }) => {
        return ownerId === inputOwnerId;
      })
      .slice(0, limit);
  }

  async findThread(inputOwnerId: string, inputThreadId: string): Promise<ConversationThread | null> {
    const thread = this.threads.get(inputThreadId);
    return thread?.ownerId === inputOwnerId ? thread : null;
  }

  async appendMessage(input: AppendMessageInput): Promise<ConversationMessage | null> {
    const thread = await this.findThread(input.ownerId, input.threadId);
    if (!thread) return null;
    const existing = input.clientRequestId
      ? this.messages.find((item) => {
          return (
            item.ownerId === input.ownerId &&
            item.threadId === input.threadId &&
            item.clientRequestId === input.clientRequestId
          );
        })
      : undefined;
    if (existing) return existing;
    const row: ConversationMessage = {
      id: `507f1f77bcf86cd7994390${this.messages.length + 20}`,
      ownerId: input.ownerId,
      threadId: input.threadId,
      sequence: thread.nextSequence,
      role: input.role,
      content: input.content,
      createdAt: now,
      ...(input.clientRequestId ? { clientRequestId: input.clientRequestId } : {}),
    };
    thread.nextSequence += 1;
    this.messages.push(row);
    return row;
  }

  async findMessageByClientRequestId(
    inputOwnerId: string,
    inputThreadId: string,
    role: AppendMessageInput['role'],
    clientRequestId: string,
  ): Promise<ConversationMessage | null> {
    return (
      this.messages.find((item) => {
        return (
          item.ownerId === inputOwnerId &&
          item.threadId === inputThreadId &&
          item.role === role &&
          item.clientRequestId === clientRequestId
        );
      }) ?? null
    );
  }

  async listRecentMessages(inputOwnerId: string, inputThreadId: string, limit: number): Promise<ConversationMessage[]> {
    return this.messages
      .filter((item) => {
        return item.ownerId === inputOwnerId && item.threadId === inputThreadId;
      })
      .slice(-limit);
  }

  async listMessagesAfterSequence(
    inputOwnerId: string,
    inputThreadId: string,
    afterSequence: number,
    limit: number,
  ): Promise<ConversationMessage[]> {
    return this.messages
      .filter((item) => {
        return item.ownerId === inputOwnerId && item.threadId === inputThreadId && item.sequence > afterSequence;
      })
      .slice(0, limit);
  }

  async saveSummary(): Promise<ConversationThread | null> {
    throw new Error('not used by ConversationService');
  }
}

const auth = { requireOwnerId: async () => ownerId } as Pick<AuthService, 'requireOwnerId'>;

test('creates a conversation and returns serialized dates without exposing ownerId', async () => {
  const service = new ConversationService(auth, new MemoryConversationStore());
  const result = await service.createThread('session');
  assert.equal(result.id, threadId);
  assert.equal(result.createdAt, now.toISOString());
  assert.equal('ownerId' in result, false);
});

test('lists only the authenticated owner conversations', async () => {
  const store = new MemoryConversationStore();
  await store.createThread(ownerId);
  store.threads.set(otherThreadId, {
    id: otherThreadId,
    ownerId: 'other-owner',
    status: 'active',
    nextSequence: 1,
    createdAt: now,
    updatedAt: now,
  }
  );
  const service = new ConversationService(auth, store);

  const result = await service.listThreads('session');

  assert.deepEqual(
    result.items.map(({ id }) => id),
    [threadId],
  );
});

test('appends only to an owned conversation and treats clientRequestId idempotently', async () => {
  const store = new MemoryConversationStore();
  await store.createThread(ownerId);
  const service = new ConversationService(auth, store);
  const first = await service.appendUserMessage('session', threadId, 'hello', 'request-1');
  const repeated = await service.appendUserMessage('session', threadId, 'hello', 'request-1');
  assert.equal(first.id, repeated.id);
  assert.equal(store.messages.length, 1);
  await assert.rejects(service.appendUserMessage('session', otherThreadId, 'hello'), (error: unknown) => {
    return typeof error === 'object' && error !== null && 'statusCode' in error && error.statusCode === 404;
  });
});

test('rejects whitespace-only messages', async () => {
  const store = new MemoryConversationStore();
  await store.createThread(ownerId);
  const service = new ConversationService(auth, store);
  await assert.rejects(service.appendUserMessage('session', threadId, '   '), (error: unknown) => {
    return typeof error === 'object' && error !== null && 'statusCode' in error && error.statusCode === 400;
  });
});
