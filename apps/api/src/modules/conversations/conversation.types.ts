export interface ConversationThread {
  id: string;
  ownerId: string;
  title?: string;

  status: 'active' | 'archived';
  nextSequence: number;
  lastMessageAt?: Date;
  summary?: ConversationSummary;

  createdAt: Date;
  updatedAt: Date;
}

export interface ConversationSummary {
  content: string;
  throughSequence: number;
  updatedAt: Date;
}

export type ConversationRole = 'user' | 'assistant' | 'system';

export interface ConversationMessage {
  id: string;
  ownerId: string;
  threadId: string;

  sequence: number;
  role: ConversationRole;
  content: string;

  clientRequestId?: string;
  inputTokens?: number;
  outputTokens?: number;
  createdAt: Date;
}

export interface TokenCounter {
  count(text: string): number;
}

export interface ContextBuilderInput {
  systemPrompt: string;
  messages: ConversationMessage[];
  maxContextTokens: number;
  responseReserveTokens: number;
  safetyMarginTokens?: number;
  messageOverheadTokens?: number;
}

export interface ContextBuilderResult {
  messages: Array<{
    role: ConversationRole;
    content: string;
  }>;

  usedTokens: number;
  omittedMessageCount: number;
}

export type ConversationMessageRole = 'user' | 'assistant';

export interface AppendMessageInput {
  ownerId: string;
  threadId: string;
  role: ConversationMessageRole;
  content: string;
  clientRequestId?: string;
  inputTokens?: number;
  outputTokens?: number;
}

export interface SaveConversationSummaryInput {
  ownerId: string;
  threadId: string;
  expectedThroughSequence: number;
  content: string;
  throughSequence: number;
}

export interface ConversationStore {
  createThread(ownerId: string): Promise<ConversationThread>;
  listThreads(ownerId: string, limit: number): Promise<ConversationThread[]>;
  findThread(ownerId: string, threadId: string): Promise<ConversationThread | null>;

  appendMessage(input: AppendMessageInput): Promise<ConversationMessage | null>;

  findMessageByClientRequestId(
    ownerId: string,
    threadId: string,
    role: ConversationMessageRole,
    clientRequestId: string,
  ): Promise<ConversationMessage | null>;

  listRecentMessages(
    ownerId: string,
    threadId: string,
    limit: number,
  ): Promise<ConversationMessage[]>;

  listMessagesAfterSequence(
    ownerId: string,
    threadId: string,
    afterSequence: number,
    limit: number,
  ): Promise<ConversationMessage[]>;

  saveSummary(input: SaveConversationSummaryInput): Promise<ConversationThread | null>;
}
