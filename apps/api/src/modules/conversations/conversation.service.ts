import type {
  ConversationMessageResponse,
  ConversationMessagesResponse,
  ConversationThreadResponse,
  ConversationThreadsResponse,
} from '@movie-hub/contract';
import { AppError } from '../../infrastructure/http/app-error.js';
import type { AuthService } from '../auth/auth.service.js';
import type { ConversationMessage, ConversationStore, ConversationThread } from './conversation.types.js';

export class ConversationService {
  constructor(
    private readonly auth: Pick<AuthService, 'requireOwnerId'>,
    private readonly conversations: ConversationStore
  ) {}

  async createThread(token: string | undefined): Promise<ConversationThreadResponse> {
    const ownerId = await this.auth.requireOwnerId(token);
    return toThreadResponse(await this.conversations.createThread(ownerId));
  }

  async listThreads(token: string | undefined): Promise<ConversationThreadsResponse> {
    const ownerId = await this.auth.requireOwnerId(token);
    const items = await this.conversations.listThreads(ownerId, 100);
    return { items: items.map(toThreadResponse) };
  }

  async listMessages(token: string | undefined, threadId: string, limit = 50): Promise<ConversationMessagesResponse> {
    const ownerId = await this.auth.requireOwnerId(token);
    await this.requireThread(ownerId, threadId);
    const items = await this.conversations.listRecentMessages(ownerId, threadId, limit);
    return { items: items.map(toMessageResponse) };
  }

  async appendUserMessage(
    token: string | undefined,
    threadId: string,
    content: string,
    clientRequestId?: string
  ): Promise<ConversationMessageResponse> {
    const ownerId = await this.auth.requireOwnerId(token);
    if (!content.trim()) throw new AppError(400, 'VALIDATION_ERROR', 'Message content cannot be blank');
    const message = await this.conversations.appendMessage({
      ownerId,
      threadId,
      role: 'user',
      content,
      ...(clientRequestId ? { clientRequestId } : {}),
    });
    if (!message) throw new AppError(404, 'NOT_FOUND', 'Conversation not found');
    return toMessageResponse(message);
  }

  private async requireThread(ownerId: string, threadId: string): Promise<ConversationThread> {
    const thread = await this.conversations.findThread(ownerId, threadId);
    if (!thread) throw new AppError(404, 'NOT_FOUND', 'Conversation not found');
    return thread;
  }
}

function toThreadResponse(thread: ConversationThread): ConversationThreadResponse {
  return {
    id: thread.id,
    status: thread.status,
    nextSequence: thread.nextSequence,
    createdAt: thread.createdAt.toISOString(),
    updatedAt: thread.updatedAt.toISOString(),
    ...(thread.title ? { title: thread.title } : {}),
    ...(thread.lastMessageAt ? { lastMessageAt: thread.lastMessageAt.toISOString() } : {}),
  };
}

function toMessageResponse(message: ConversationMessage): ConversationMessageResponse {
  return {
    id: message.id,
    threadId: message.threadId,
    sequence: message.sequence,
    role: message.role,
    content: message.content,
    createdAt: message.createdAt.toISOString(),
    ...(message.clientRequestId ? { clientRequestId: message.clientRequestId } : {}),
  };
}
