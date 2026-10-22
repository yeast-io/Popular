import { createAssistantConversationReply } from '../assistant/assistant.conversation.js';
import { emptyProfile } from '../preferences/preference.domain.js';
import type { PreferenceService } from '../preferences/preference.service.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { LlmProviderError } from '../llm/llm.errors.js';
import type { LlmClient, LlmGenerateInput, LlmGenerateResult, LlmStreamEvent } from '../llm/llm.types.js';
import { ContextBudgetExceededError } from './context-builder.js';
import { ConversationTurnService } from './conversation-turn.service.js';
import type {
  AppendMessageInput,
  ConversationMessage,
  ConversationStore,
  ConversationThread,
  TokenCounter,
} from './conversation.types.js';

class FakeLlmClient implements LlmClient {
  lastInput: LlmGenerateInput | null = null;
  calls = 0;

  constructor(
    private readonly result: LlmGenerateResult = {
      content: 'fake assistant response',
      inputTokens: 20,
      outputTokens: 3,
    }
  ) {}

  async generate(input: LlmGenerateInput): Promise<LlmGenerateResult> {
    this.calls += 1;
    this.lastInput = input;
    return this.result;
  }

  async* stream(input: LlmGenerateInput): AsyncIterable<LlmStreamEvent> {
    this.calls += 1;
    this.lastInput = input;
    yield { type: 'delta', delta: this.result.content.slice(0, 7) };
    yield { type: 'delta', delta: this.result.content.slice(7) };
    yield {
      type: 'completed',
      inputTokens: this.result.inputTokens,
      outputTokens: this.result.outputTokens,
    };
  }
}

class FailingLlmClient implements LlmClient {
  async generate(): Promise<never> {
    throw new LlmProviderError('provider unavailable');
  }

  async* stream(): AsyncIterable<LlmStreamEvent> {
    throw new LlmProviderError('provider unavailable');
  }
}

class QueueLlmClient implements LlmClient {
  readonly inputs: LlmGenerateInput[] = [];

  constructor(private readonly results: LlmGenerateResult[]) {}

  async generate(input: LlmGenerateInput): Promise<LlmGenerateResult> {
    this.inputs.push(input);
    const result = this.results.shift();
    if (!result) throw new Error('Unexpected LLM call');
    return result;
  }

  async* stream(): AsyncIterable<LlmStreamEvent> {
    throw new Error('Unexpected streaming LLM call');
  }
}

class MemoryConversationStore implements ConversationStore {
  readonly thread: ConversationThread = {
    id: 'thread-1',
    ownerId: 'owner-1',
    status: 'active',
    nextSequence: 1,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  };

  readonly messages: ConversationMessage[] = [];

  async createThread(): Promise<ConversationThread> {
    return this.thread;
  }

  async listThreads(ownerId: string): Promise<ConversationThread[]> {
    return ownerId === this.thread.ownerId ? [this.thread] : [];
  }

  async findThread(ownerId: string, threadId: string): Promise<ConversationThread | null> {
    return ownerId === this.thread.ownerId && threadId === this.thread.id ? this.thread : null;
  }

  async appendMessage(input: AppendMessageInput): Promise<ConversationMessage | null> {
    if (!(await this.findThread(input.ownerId, input.threadId))) return null;
    if (input.clientRequestId) {
      const existing = this.messages.find((message) => {
        return message.role === input.role && message.clientRequestId === input.clientRequestId;
      });
      if (existing) return existing;
    }
    const message: ConversationMessage = {
      id: `message-${this.thread.nextSequence}`,
      ownerId: input.ownerId,
      threadId: input.threadId,
      sequence: this.thread.nextSequence,
      role: input.role,
      content: input.content,
      createdAt: new Date(`2026-01-01T00:00:${String(this.thread.nextSequence).padStart(2, '0')}.000Z`),
      ...(input.clientRequestId ? { clientRequestId: input.clientRequestId } : {}),
      ...(input.inputTokens === undefined ? {} : { inputTokens: input.inputTokens }),
      ...(input.outputTokens === undefined ? {} : { outputTokens: input.outputTokens }),
    };
    this.thread.nextSequence += 1;
    this.messages.push(message);
    return message;
  }

  async findMessageByClientRequestId(
    ownerId: string,
    threadId: string,
    role: AppendMessageInput['role'],
    clientRequestId: string
  ): Promise<ConversationMessage | null> {
    return (
      this.messages.find((message) => {
        return (
          message.ownerId === ownerId
          && message.threadId === threadId
          && message.role === role
          && message.clientRequestId === clientRequestId
        );
      }) ?? null
    );
  }

  async listRecentMessages(ownerId: string, threadId: string, limit: number): Promise<ConversationMessage[]> {
    return this.messages
      .filter((message) => message.ownerId === ownerId && message.threadId === threadId)
      .slice(-limit);
  }

  async listMessagesAfterSequence(
    ownerId: string,
    threadId: string,
    afterSequence: number,
    limit: number
  ): Promise<ConversationMessage[]> {
    return this.messages
      .filter((message) => {
        return message.ownerId === ownerId && message.threadId === threadId && message.sequence > afterSequence;
      })
      .slice(0, limit);
  }

  async saveSummary(input: {
    ownerId: string;
    threadId: string;
    expectedThroughSequence: number;
    content: string;
    throughSequence: number;
  }): Promise<ConversationThread | null> {
    if (!(await this.findThread(input.ownerId, input.threadId))) return null;
    if ((this.thread.summary?.throughSequence ?? 0) !== input.expectedThroughSequence) return null;
    this.thread.summary = {
      content: input.content,
      throughSequence: input.throughSequence,
      updatedAt: new Date('2026-01-01T00:10:00.000Z'),
    };
    return this.thread;
  }
}

const tokenCounter: TokenCounter = { count: (text) => text.length };

test('web discussion keeps streaming and counts classification usage with the preference context budget', async () => {
  const store = new MemoryConversationStore();
  const llm = new FakeLlmClient();
  const service = new ConversationTurnService(store, llm, tokenCounter, {
    systemPrompt: 'Be concise',
    maxContextTokens: 4000,
    maxOutputTokens: 100,
    summaryMaxOutputTokens: 100,
    profileContext: async () => 'User preference data: likes history movies',
    reply: async (_input, messages, client) => {
      return {
        content: '',
        inputTokens: 5,
        outputTokens: 2,
        stream: client.stream({ messages, maxOutputTokens: 100, operation: 'assistant.discuss' }),
      };
    },
  });
  const events = [];
  for await (const event of service.stream({
    ownerId: 'owner-1',
    threadId: 'thread-1',
    clientRequestId: 'web-profile-1',
    content: 'Hello',
  }
  ))
    events.push(event);
  assert.equal(events.filter((event) => event.type === 'delta').length, 2);
  assert.equal(events.at(-1)?.type, 'completed');
  const completed = events.at(-1);
  if (completed?.type === 'completed') assert.deepEqual(completed.usage, { inputTokens: 25, outputTokens: 5 });
  assert.ok(
    llm.lastInput?.messages.some(
      (message) => message.role === 'user' && message.content.includes('likes history movies')
    )
  );
});
const options = {
  systemPrompt: 'You are concise.',
  maxContextTokens: 200,
  maxOutputTokens: 30,
  summaryMaxOutputTokens: 20,
  messageOverheadTokens: 1,
};

test('sends selected conversation context to the LLM', async () => {
  const store = new MemoryConversationStore();
  await store.appendMessage({ ownerId: 'owner-1', threadId: 'thread-1', role: 'user', content: 'My name is Daniel.' });
  await store.appendMessage({
    ownerId: 'owner-1',
    threadId: 'thread-1',
    role: 'assistant',
    content: 'Nice to meet you.',
  }
  );
  const client = new FakeLlmClient();
  const service = new ConversationTurnService(store, client, tokenCounter, options);

  await service.run({
    ownerId: 'owner-1',
    threadId: 'thread-1',
    content: 'What is my name?',
    clientRequestId: 'request-context',
  }
  );

  assert.deepEqual(client.lastInput, {
    messages: [
      { role: 'system', content: 'You are concise.' },
      { role: 'user', content: 'My name is Daniel.' },
      { role: 'assistant', content: 'Nice to meet you.' },
      { role: 'user', content: 'What is my name?' },
    ],
    maxOutputTokens: 30,
  }
  );
});

test('persists the assistant response after generation', async () => {
  const store = new MemoryConversationStore();
  const service = new ConversationTurnService(store, new FakeLlmClient(), tokenCounter, options);

  const result = await service.run({
    ownerId: 'owner-1',
    threadId: 'thread-1',
    content: 'Hello',
    clientRequestId: 'request-1',
  }
  );

  assert.equal(result.userMessage.role, 'user');
  assert.equal(result.assistantMessage.role, 'assistant');
  assert.equal(result.assistantMessage.content, 'fake assistant response');
  assert.deepEqual(result.usage, { inputTokens: 20, outputTokens: 3 });
  assert.deepEqual(
    store.messages.map(({ role }) => role),
    ['user', 'assistant']
  );
});

test('streams deltas and persists the assistant only after provider completion', async () => {
  const store = new MemoryConversationStore();
  const client = new FakeLlmClient();
  const service = new ConversationTurnService(store, client, tokenCounter, options);
  const iterator = service
    .stream({
      ownerId: 'owner-1',
      threadId: 'thread-1',
      content: 'Hello',
      clientRequestId: 'request-stream',
    }
    )[Symbol.asyncIterator]();

  assert.equal((await iterator.next()).value?.type, 'user_message');
  assert.equal((await iterator.next()).value?.type, 'delta');
  assert.deepEqual(
    store.messages.map(({ role }) => role),
    ['user']
  );
  assert.equal((await iterator.next()).value?.type, 'delta');
  const completed = await iterator.next();

  assert.equal(completed.value?.type, 'completed');
  assert.deepEqual(
    store.messages.map(({ role }) => role),
    ['user', 'assistant']
  );
  assert.equal(store.messages[1]?.content, 'fake assistant response');
});

test('does not persist partial streamed output when the provider fails', async () => {
  const store = new MemoryConversationStore();
  const service = new ConversationTurnService(store, new FailingLlmClient(), tokenCounter, options);

  await assert.rejects(
    async () => {
      for await (const _event of service.stream({
        ownerId: 'owner-1',
        threadId: 'thread-1',
        content: 'Hello',
        clientRequestId: 'request-stream-failure',
      }
      )) {
        // Consume the stream to surface the provider error.
      }
    },
    (error: unknown) => {
      return typeof error === 'object' && error !== null && 'statusCode' in error && error.statusCode === 503;
    });

  assert.deepEqual(
    store.messages.map(({ role }) => role),
    ['user']
  );
});

test('does not persist an assistant message when generation fails', async () => {
  const store = new MemoryConversationStore();
  const service = new ConversationTurnService(store, new FailingLlmClient(), tokenCounter, options);

  await assert.rejects(
    service.run({ ownerId: 'owner-1', threadId: 'thread-1', content: 'Hello', clientRequestId: 'request-failure' }),
    (error: unknown) => {
      return typeof error === 'object' && error !== null && 'statusCode' in error && error.statusCode === 503;
    });

  assert.deepEqual(
    store.messages.map(({ role }) => role),
    ['user']
  );
});

test('rejects the turn when the newest user message exceeds budget', async () => {
  const store = new MemoryConversationStore();
  const service = new ConversationTurnService(store, new FakeLlmClient(), tokenCounter, {
    ...options,
    maxContextTokens: 30,
    maxOutputTokens: 10,
  });

  await assert.rejects(
    service.run({
      ownerId: 'owner-1',
      threadId: 'thread-1',
      content: 'This message cannot fit.',
      clientRequestId: 'request-large',
    }
    ),
    ContextBudgetExceededError
  );
  assert.equal(store.messages.length, 0);
});

test('reuses a completed assistant message instead of calling the provider again', async () => {
  const store = new MemoryConversationStore();
  const client = new FakeLlmClient();
  const service = new ConversationTurnService(store, client, tokenCounter, options);
  const input = {
    ownerId: 'owner-1',
    threadId: 'thread-1',
    content: 'Hello',
    clientRequestId: 'request-1',
  };

  const first = await service.run(input);
  const repeated = await service.run(input);

  assert.equal(client.calls, 1);
  assert.equal(repeated.assistantMessage.id, first.assistantMessage.id);
  assert.deepEqual(repeated.usage, first.usage);
});

test('coalesces concurrent retries into one provider call', async () => {
  const store = new MemoryConversationStore();
  const client = new FakeLlmClient();
  const service = new ConversationTurnService(store, client, tokenCounter, options);
  const input = {
    ownerId: 'owner-1',
    threadId: 'thread-1',
    content: 'Hello',
    clientRequestId: 'request-concurrent',
  };

  const [first, repeated] = await Promise.all([service.run(input), service.run(input)]);

  assert.equal(client.calls, 1);
  assert.equal(repeated.assistantMessage.id, first.assistantMessage.id);
  assert.deepEqual(
    store.messages.map(({ role }) => role),
    ['user', 'assistant']
  );
});

test('summarizes omitted history, persists the checkpoint, and sends the summary with recent messages', async () => {
  const store = new MemoryConversationStore();
  await store.appendMessage({
    ownerId: 'owner-1',
    threadId: 'thread-1',
    role: 'user',
    content: 'x'.repeat(200),
  });
  await store.appendMessage({
    ownerId: 'owner-1',
    threadId: 'thread-1',
    role: 'assistant',
    content: 'r'.repeat(250),
  });
  const client = new QueueLlmClient([
    { content: 'User provided an older detail.', inputTokens: 40, outputTokens: 7 },
    { content: 'final answer', inputTokens: 30, outputTokens: 3 },
  ]);
  const service = new ConversationTurnService(store, client, tokenCounter, {
    ...options,
    systemPrompt: 'S',
    maxContextTokens: 650,
    maxOutputTokens: 20,
  });

  const result = await service.run({
    ownerId: 'owner-1',
    threadId: 'thread-1',
    content: 'q'.repeat(180),
    clientRequestId: 'request-summary',
  }
  );

  assert.equal(client.inputs.length, 2);
  assert.match(client.inputs[0]?.messages[1]?.content ?? '', /\[1\] user: x+/);
  assert.match(client.inputs[1]?.messages[0]?.content ?? '', /User provided an older detail/);
  assert.deepEqual(
    client.inputs[1]?.messages.slice(1).map(({ content }) => content),
    ['r'.repeat(250), 'q'.repeat(180)]
  );
  assert.equal(store.thread.summary?.throughSequence, 1);
  assert.equal(result.assistantMessage.content, 'final answer');
});

test('summarizes the oldest batch before it falls outside the history window', async () => {
  const store = new MemoryConversationStore();
  await store.appendMessage({ ownerId: 'owner-1', threadId: 'thread-1', role: 'user', content: 'one' });
  await store.appendMessage({ ownerId: 'owner-1', threadId: 'thread-1', role: 'assistant', content: 'two' });
  await store.appendMessage({ ownerId: 'owner-1', threadId: 'thread-1', role: 'user', content: 'three' });
  const client = new QueueLlmClient([
    { content: 'The earlier exchange covered one and two.', inputTokens: 30, outputTokens: 8 },
    { content: 'final answer', inputTokens: 20, outputTokens: 3 },
  ]);
  const service = new ConversationTurnService(store, client, tokenCounter, {
    ...options,
    maxContextTokens: 1_000,
    historyLimit: 2,
  });

  await service.run({
    ownerId: 'owner-1',
    threadId: 'thread-1',
    content: 'four',
    clientRequestId: 'request-window',
  });

  assert.equal(client.inputs.length, 2);
  assert.match(client.inputs[0]?.messages[1]?.content ?? '', /\[1\] user: one/);
  assert.match(client.inputs[0]?.messages[1]?.content ?? '', /\[2\] assistant: two/);
  assert.equal(store.thread.summary?.throughSequence, 2);
  assert.deepEqual(
    client.inputs[1]?.messages.slice(1).map(({ content }) => content),
    ['three', 'four']
  );
});

test('resolves a fresh account client for every normal and streaming turn', async () => {
  const store = new MemoryConversationStore();
  const resolvedOwners: string[] = [];
  const clients = [
    new FakeLlmClient({ content: 'first key', inputTokens: 1, outputTokens: 1 }),
    new FakeLlmClient({ content: 'replacement key', inputTokens: 1, outputTokens: 1 }),
  ];
  let configured = true;
  const service = new ConversationTurnService(
    store,
    async (ownerId) => {
      resolvedOwners.push(ownerId);
      if (!configured) throw new Error('Key deleted');
      return clients[resolvedOwners.length - 1]!;
    },
    tokenCounter,
    options
  );
  const result = await service.run({
    ownerId: 'owner-1',
    threadId: 'thread-1',
    content: 'hello',
    clientRequestId: 'first',
  }
  );
  assert.equal(result.assistantMessage.content, 'first key');
  for await (const _event of service.stream({
    ownerId: 'owner-1',
    threadId: 'thread-1',
    content: 'again',
    clientRequestId: 'second',
  }
  )) {
    /* consume */
  }
  assert.equal(store.messages.at(-1)?.content, 'replacement key');
  configured = false;
  const before = store.messages.length;
  await assert.rejects(
    service.run({ ownerId: 'owner-1', threadId: 'thread-1', content: 'blocked', clientRequestId: 'third' }),
    /Key deleted/
  );
  assert.equal(store.messages.length, before);
  assert.deepEqual(resolvedOwners, ['owner-1', 'owner-1', 'owner-1']);
});

for (const streaming of [false, true]) {
  test(`shared assistant web integration preserves summary, preferences and usage (streaming=${streaming})`, async () => {
    const store = new MemoryConversationStore();
    store.thread.summary = { content: 'Earlier conversation facts', throughSequence: 0, updatedAt: new Date() };
    const requests: LlmGenerateInput[] = [];
    const llm: LlmClient = {
      generate: async (request) => {
        requests.push(request);
        return request.operation === 'assistant.intent'
          ? { content: '{"intent":"discuss","preferenceSignal":"explicit"}', inputTokens: 5, outputTokens: 2 }
          : { content: 'Unified reply', inputTokens: 20, outputTokens: 3 };
      },
      stream: async function* (request) {
        requests.push(request);
        yield { type: 'delta', delta: 'Unified ' };
        yield { type: 'delta', delta: 'reply' };
        yield { type: 'completed', inputTokens: 20, outputTokens: 3 };
      },
    };
    let enqueued = false;
    const preferences = {
      chatEvidence: async () => {
        enqueued = true;
      },
      store: {
        read: async () => {
          return { ...emptyProfile(), entries: [{ section: 'explicit', content: 'Likes history movies' }] };
        },
      },
    } as unknown as PreferenceService;
    const service = new ConversationTurnService(store, llm, tokenCounter, {
      ...options,
      maxContextTokens: 8000,
      reply: createAssistantConversationReply({
        systemPrompt: options.systemPrompt,
        maxContextTokens: 8000,
        maxOutputTokens: 100,
        preferences,
      }
      ),
    });
    const input = { ownerId: 'owner-1', threadId: 'thread-1', clientRequestId: 'shared-web', content: 'Hello' };
    if (streaming) {
      const events = [];
      for await (const event of service.stream(input)) events.push(event);
      assert.equal(events.filter((event) => event.type === 'delta').length, 2);
      const result = events.at(-1);
      assert.equal(result?.type, 'completed');
      if (result?.type === 'completed') assert.deepEqual(result.usage, { inputTokens: 25, outputTokens: 5 });
    } else {
      const result = await service.run(input);
      assert.deepEqual(result.usage, { inputTokens: 25, outputTokens: 5 });
      assert.equal(result.assistantMessage.content, 'Unified reply');
    }
    assert.equal(requests.length, 2);
    assert.equal(requests[1]?.operation, 'assistant.discuss');
    assert.ok(requests[1]?.messages[0]?.content.includes('Earlier conversation facts'));
    assert.equal(requests[1]?.messages.filter((message) => message.content.includes('Likes history movies')).length, 1);
    assert.equal(requests[1]?.messages.filter((message) => message.content === 'Hello').length, 1);
    assert.ok(enqueued);
    assert.equal(store.messages.filter((message) => message.role === 'assistant').length, 1);
    // Completed turns are reused before classification, tool execution or preference enqueue.
    await service.run(input);
    assert.equal(requests.length, 2);
  });
}

test('a failed unified assistant stream does not save a partial reply', async () => {
  const store = new MemoryConversationStore();
  const llm: LlmClient = {
    generate: async () => ({ content: '{"intent":"discuss"}', inputTokens: 5, outputTokens: 2 }),
    stream: async function* () {
      yield { type: 'delta', delta: 'Partial response' };
      throw new LlmProviderError('connection interrupted');
    },
  };
  const service = new ConversationTurnService(store, llm, tokenCounter, {
    ...options,
    reply: createAssistantConversationReply({
      systemPrompt: options.systemPrompt,
      maxContextTokens: 8000,
      maxOutputTokens: 100,
    }
    ),
  });
  await assert.rejects(async () => {
    for await (const _event of service.stream({
      ownerId: 'owner-1',
      threadId: 'thread-1',
      clientRequestId: 'failed-shared-web',
      content: 'Hello',
    }
    )) {
      /* consume */
    }
  });
  assert.equal(store.messages.filter((message) => message.role === 'assistant').length, 0);
});
