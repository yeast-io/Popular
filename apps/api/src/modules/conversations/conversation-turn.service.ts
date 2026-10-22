import type {
  ConversationTurnOptions,
  RunConversationTurnInput,
  ConversationTurnStreamEvent,
  ConversationTurnResult,
} from './conversation-turn.types.js';
import { aiStep, currentAiTrace } from '../../infrastructure/logging/ai-trace.js';
import { AppError } from '../../infrastructure/http/app-error.js';
import { LlmProviderError } from '../llm/llm.errors.js';
import type { LlmClient, LlmStreamEvent, LlmGenerateResult } from '../llm/llm.types.js';
import { buildConversationContext } from './context-builder.js';
import { buildSummaryRequest, systemPromptWithSummary } from './conversation-summary.js';
import type {
  ContextBuilderResult,
  ConversationMessage,
  ConversationStore,
  ConversationSummary,
  ConversationThread,
  TokenCounter,
} from './conversation.types.js';

export class ConversationTurnService {
  private readonly inFlight = new Map<string, Promise<ConversationTurnResult>>();
  private readonly streaming = new Set<string>();

  constructor(
    private readonly conversations: ConversationStore,
    private readonly llm: LlmClient | ((ownerId: string) => Promise<LlmClient>),
    private readonly tokenCounter: TokenCounter,
    private readonly options: ConversationTurnOptions
  ) {}

  run(input: RunConversationTurnInput): Promise<ConversationTurnResult> {
    const key = this.turnKey(input);
    if (this.streaming.has(key)) {
      return Promise.reject(new AppError(409, 'CONFLICT', 'This conversation turn is already in progress'));
    }
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    const operation = this.runOnce(input).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, operation);
    return operation;
  }

  async* stream(input: RunConversationTurnInput): AsyncIterable<ConversationTurnStreamEvent> {
    const key = this.turnKey(input);
    if (this.streaming.has(key) || this.inFlight.has(key)) {
      throw new AppError(409, 'CONFLICT', 'This conversation turn is already in progress');
    }
    this.streaming.add(key);

    try {
      const llm = await aiStep('model.client', async () => {
        return typeof this.llm === 'function' ? this.llm(input.ownerId) : this.llm;
      });
      const prepared = await aiStep('turn.prepare', () => this.prepareTurn(input, llm));
      yield { type: 'user_message', message: prepared.userMessage };

      if (prepared.completed) {
        yield { type: 'delta', delta: prepared.completed.assistantMessage.content };
        yield {
          type: 'completed',
          assistantMessage: prepared.completed.assistantMessage,
          usage: prepared.completed.usage,
        };
        return;
      }

      let assistantStream: AsyncIterable<LlmStreamEvent> | undefined;
      let preludeUsage = { inputTokens: 0, outputTokens: 0 };
      if (this.options.reply) {
        const generated = await this.options.reply(input, prepared.context.messages, llm, true);
        preludeUsage = { inputTokens: generated.inputTokens, outputTokens: generated.outputTokens };
        assistantStream = generated.stream;
        if (!assistantStream) {
          input.signal?.throwIfAborted();
          if (!generated.content.trim()) throw new AppError(503, 'SERVICE_UNAVAILABLE', 'AI returned an empty reply');
          const usage = { inputTokens: generated.inputTokens, outputTokens: generated.outputTokens };
          const assistantMessage = await this.appendAssistant(input, generated.content, usage);
          yield { type: 'delta', delta: generated.content };
          yield { type: 'completed', assistantMessage, usage };
          return;
        }
      }

      currentAiTrace()?.event('model.stream.started', { maxOutputTokens: this.options.maxOutputTokens });
      let content = '';
      let usage: ConversationTurnResult['usage'] | undefined;
      try {
        for await (const event of assistantStream
          ?? llm.stream({
            messages: prepared.context.messages,
            maxOutputTokens: this.options.maxOutputTokens,
            ...(input.signal ? { signal: input.signal } : {}),
          })) {
          if (event.type === 'delta') {
            content += event.delta;
            yield event;
          } else {
            usage = {
              inputTokens: event.inputTokens + preludeUsage.inputTokens,
              outputTokens: event.outputTokens + preludeUsage.outputTokens,
            };
          }
        }
      } catch (error) {
        this.rethrowProviderError(error);
      }

      currentAiTrace()?.sensitive(content);
      currentAiTrace()?.event('model.stream.completed', { outputCharacters: content.length, ...usage });
      if (!content.trim() || !usage) {
        throw new AppError(503, 'SERVICE_UNAVAILABLE', 'AI service returned an incomplete response');
      }
      const assistantMessage = await this.appendAssistant(input, content, usage);
      yield { type: 'completed', assistantMessage, usage };
    } finally {
      this.streaming.delete(key);
    }
  }

  private async runOnce(input: RunConversationTurnInput): Promise<ConversationTurnResult> {
    const llm = await aiStep('model.client', async () => {
      return typeof this.llm === 'function' ? this.llm(input.ownerId) : this.llm;
    });
    const prepared = await aiStep('turn.prepare', () => this.prepareTurn(input, llm));
    if (prepared.completed) return prepared.completed;

    const routed = this.options.reply ? await this.options.reply(input, prepared.context.messages, llm) : undefined;
    const generated
      = routed
        ?? (await this.generate(llm, {
          messages: prepared.context.messages,
          maxOutputTokens: this.options.maxOutputTokens,
          ...(input.signal ? { signal: input.signal } : {}),
        }));
    if (!generated.content.trim()) {
      throw new AppError(503, 'SERVICE_UNAVAILABLE', 'AI service returned no response');
    }

    const usage = { inputTokens: generated.inputTokens, outputTokens: generated.outputTokens };
    const assistantMessage = await this.appendAssistant(input, generated.content, usage);
    return { userMessage: prepared.userMessage, assistantMessage, usage };
  }

  private async prepareTurn(
    input: RunConversationTurnInput,
    llm: LlmClient
  ): Promise<{
    userMessage: ConversationMessage;
    completed?: ConversationTurnResult;
    context: ContextBuilderResult;
  }> {
    if (!input.content.trim()) throw new AppError(400, 'VALIDATION_ERROR', 'Message content cannot be blank');
    if (!input.clientRequestId) throw new AppError(400, 'VALIDATION_ERROR', 'clientRequestId is required');
    this.assertCurrentMessageFits(input);

    const userMessage = await aiStep('message.user.save', () => {
      return this.conversations.appendMessage({
        ownerId: input.ownerId,
        threadId: input.threadId,
        role: 'user',
        content: input.content,
        clientRequestId: input.clientRequestId,
      }
      );
    });
    if (!userMessage) throw new AppError(404, 'NOT_FOUND', 'Conversation not found');

    const completed = await aiStep('message.idempotency_lookup', () => {
      return this.conversations.findMessageByClientRequestId(
        input.ownerId,
        input.threadId,
        'assistant',
        input.clientRequestId
      );
    });
    if (completed) {
      if (completed.inputTokens === undefined || completed.outputTokens === undefined) {
        throw new Error('Completed assistant message is missing token usage');
      }
      const result = {
        userMessage,
        assistantMessage: completed,
        usage: { inputTokens: completed.inputTokens, outputTokens: completed.outputTokens },
      };
      return { userMessage, completed: result, context: { messages: [], usedTokens: 0, omittedMessageCount: 0 } };
    }

    const thread = await aiStep('thread.load', () => {
      return this.conversations.findThread(input.ownerId, input.threadId);
    });
    if (!thread) throw new AppError(404, 'NOT_FOUND', 'Conversation not found');
    return { userMessage, context: await this.buildContext(thread, llm, input.signal) };
  }

  private async appendAssistant(
    input: RunConversationTurnInput,
    content: string,
    usage: ConversationTurnResult['usage']
  ): Promise<ConversationMessage> {
    const assistantMessage = await aiStep('message.assistant.save', () => {
      return this.conversations.appendMessage({
        ownerId: input.ownerId,
        threadId: input.threadId,
        role: 'assistant',
        content,
        clientRequestId: input.clientRequestId,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
      }
      );
    });
    if (!assistantMessage) throw new AppError(404, 'NOT_FOUND', 'Conversation not found');

    return assistantMessage;
  }

  private async buildContext(
    thread: ConversationThread,
    llm: LlmClient,
    signal?: AbortSignal
  ): Promise<ContextBuilderResult> {
    currentAiTrace()?.event('context.build.started');
    let summary = thread.summary;
    if (summary) currentAiTrace()?.sensitive(summary.content);
    const historyLimit = this.options.historyLimit ?? 100;
    const userContext = (await this.options.profileContext?.(thread.ownerId)) ?? '';

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const freshMessages = await aiStep('history.load', () => {
        return this.conversations.listMessagesAfterSequence(
          thread.ownerId,
          thread.id,
          summary?.throughSequence ?? 0,
          historyLimit + 1
        );
      });
      for (const message of freshMessages) currentAiTrace()?.sensitive(message.content);
      const context = this.selectContext(freshMessages, summary, userContext);
      const hasBacklog = freshMessages.length > historyLimit;
      if (!hasBacklog && context.omittedMessageCount === 0) {
        currentAiTrace()?.event('context.build.completed', {
          messageCount: context.messages.length,
          usedTokens: context.usedTokens,
        });
        return context;
      }
      currentAiTrace()?.event('summary.required', {
        attempt,
        omittedMessageCount: context.omittedMessageCount,
        hasBacklog,
      });

      const candidates = hasBacklog
        ? freshMessages.slice(0, historyLimit)
        : freshMessages.slice(0, context.omittedMessageCount);
      const omitted = this.selectSummaryBatch(summary, candidates);
      const lastOmitted = omitted.at(-1);
      if (!lastOmitted) {
        throw new AppError(503, 'SERVICE_UNAVAILABLE', 'Old conversation messages cannot fit the summary budget');
      }
      const generated = await this.generate(llm, {
        ...buildSummaryRequest(summary, omitted, this.options.summaryMaxOutputTokens),
        ...(signal ? { signal } : {}),
      });
      if (!generated.content.trim()) {
        throw new AppError(503, 'SERVICE_UNAVAILABLE', 'AI service returned no summary');
      }

      const saved = await aiStep('summary.save', () => {
        return this.conversations.saveSummary({
          ownerId: thread.ownerId,
          threadId: thread.id,
          expectedThroughSequence: summary?.throughSequence ?? 0,
          content: generated.content,
          throughSequence: lastOmitted.sequence,
        }
        );
      });
      if (saved?.summary) {
        summary = saved.summary;
      } else {
        const current = await aiStep('thread.load', () => {
          return this.conversations.findThread(thread.ownerId, thread.id);
        });
        if (!current) throw new AppError(404, 'NOT_FOUND', 'Conversation not found');
        summary = current.summary;
      }
    }

    throw new AppError(503, 'SERVICE_UNAVAILABLE', 'Conversation summary could not fit the context budget');
  }

  private selectSummaryBatch(
    summary: ConversationSummary | undefined,
    candidates: ConversationMessage[]
  ): ConversationMessage[] {
    const selected: ConversationMessage[] = [];
    const maxInputTokens
      = this.options.maxContextTokens - this.options.summaryMaxOutputTokens - (this.options.safetyMarginTokens ?? 0);
    const messageOverhead = this.options.messageOverheadTokens ?? 4;

    for (const candidate of candidates) {
      const next = [...selected, candidate];
      const request = buildSummaryRequest(summary, next, this.options.summaryMaxOutputTokens);
      const tokens = request.messages.reduce(
        (total, message) => total + this.tokenCounter.count(message.content) + messageOverhead,
        0
      );
      if (tokens > maxInputTokens) break;
      selected.push(candidate);
    }
    return selected;
  }

  private selectContext(
    messages: ConversationMessage[],
    summary: ConversationSummary | undefined,
    userContext = ''
  ): ContextBuilderResult {
    return buildConversationContext(
      {
        userContext,
        systemPrompt: systemPromptWithSummary(this.options.systemPrompt, summary),
        messages,
        maxContextTokens: this.options.maxContextTokens,
        responseReserveTokens: this.options.maxOutputTokens,
        ...(this.options.safetyMarginTokens === undefined
          ? {}
          : { safetyMarginTokens: this.options.safetyMarginTokens }),
        ...(this.options.messageOverheadTokens === undefined
          ? {}
          : { messageOverheadTokens: this.options.messageOverheadTokens }),
      },
      this.tokenCounter
    );
  }

  private async generate(llm: LlmClient, input: Parameters<LlmClient['generate']>[0]): Promise<LlmGenerateResult> {
    try {
      const result = await aiStep(
        'model.generate',
        () => {
          return llm.generate(input);
        },
        { maxOutputTokens: input.maxOutputTokens }
      );
      currentAiTrace()?.sensitive(result.content);
      currentAiTrace()?.event('model.usage', { inputTokens: result.inputTokens, outputTokens: result.outputTokens });
      return result;
    } catch (error) {
      if (!(error instanceof LlmProviderError)) throw error;
      throw new AppError(503, 'SERVICE_UNAVAILABLE', 'AI service is temporarily unavailable', undefined, {
        cause: error,
      });
    }
  }

  private rethrowProviderError(error: unknown): never {
    if (!(error instanceof LlmProviderError)) throw error;
    throw new AppError(503, 'SERVICE_UNAVAILABLE', 'AI service is temporarily unavailable', undefined, {
      cause: error,
    });
  }

  private turnKey(input: RunConversationTurnInput): string {
    return `${input.ownerId}:${input.threadId}:${input.clientRequestId}`;
  }

  private assertCurrentMessageFits(input: RunConversationTurnInput): void {
    buildConversationContext(
      {
        systemPrompt: this.options.systemPrompt,
        messages: [
          {
            id: 'pending',
            ownerId: input.ownerId,
            threadId: input.threadId,
            sequence: 1,
            role: 'user',
            content: input.content,
            createdAt: new Date(0),
          },
        ],
        maxContextTokens: this.options.maxContextTokens,
        responseReserveTokens: this.options.maxOutputTokens,
        ...(this.options.safetyMarginTokens === undefined
          ? {}
          : { safetyMarginTokens: this.options.safetyMarginTokens }),
        ...(this.options.messageOverheadTokens === undefined
          ? {}
          : { messageOverheadTokens: this.options.messageOverheadTokens }),
      },
      this.tokenCounter
    );
  }
}
