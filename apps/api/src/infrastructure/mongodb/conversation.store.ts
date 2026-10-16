import type { Model } from 'mongoose';
import type { AppendMessageInput, ConversationMessage, ConversationStore, ConversationThread, SaveConversationSummaryInput } from '../../modules/conversations/conversation.types.js';
import type { ConversationMessageDocument } from './conversation-message.schema.js';
import type { ConversationThreadDocument } from './conversation-thread.schema.js';

export class MongoConversationStore implements ConversationStore {
  constructor(
    private readonly threads: Model<ConversationThreadDocument>,
    private readonly messages: Model<ConversationMessageDocument>,
  ) {}

  async createThread(ownerId: string): Promise<ConversationThread> {
    const row = await this.threads.create({ ownerId, status: 'active' });
    return toThread(row);
  }

  async listThreads(ownerId: string, limit: number): Promise<ConversationThread[]> {
    const rows = await this.threads.find({ ownerId })
      .sort({ updatedAt: -1 })
      .limit(limit)
      .exec();
    return rows.map(toThread);
  }

  async findThread(ownerId: string, threadId: string): Promise<ConversationThread | null> {
    const row = await this.threads.findOne({ _id: threadId, ownerId }).exec();
    return row ? toThread(row) : null;
  }

  async appendMessage(input: AppendMessageInput): Promise<ConversationMessage | null> {
    if (input.clientRequestId) {
      const existing = await this.messages.findOne({
        ownerId: input.ownerId,
        threadId: input.threadId,
        role: input.role,
        clientRequestId: input.clientRequestId,
      }).exec();
      if (existing) return toMessage(existing);
    }

    const now = new Date();
    const thread = await this.threads.findOneAndUpdate(
      { _id: input.threadId, ownerId: input.ownerId, status: 'active' },
      { $inc: { nextSequence: 1 }, $set: { lastMessageAt: now } },
      { new: false },
    ).exec();
    if (!thread) return null;

    try {
      const row = await this.messages.create({
        ownerId: input.ownerId,
        threadId: input.threadId,
        sequence: thread.nextSequence,
        role: input.role,
        content: input.content,
        ...(input.clientRequestId ? { clientRequestId: input.clientRequestId } : {}),
        ...(input.inputTokens === undefined ? {} : { inputTokens: input.inputTokens }),
        ...(input.outputTokens === undefined ? {} : { outputTokens: input.outputTokens }),
        createdAt: now,
      });
      if (thread.nextSequence === 1 && input.role === 'user') {
        await this.threads.updateOne(
          { _id: input.threadId, ownerId: input.ownerId, title: { $exists: false } },
          { $set: { title: titleFromFirstMessage(input.content) } },
        ).exec();
      }
      return toMessage(row);
    } catch (error) {
      if (!input.clientRequestId || !isDuplicateKey(error)) throw error;
      const existing = await this.messages.findOne({
        ownerId: input.ownerId,
        threadId: input.threadId,
        role: input.role,
        clientRequestId: input.clientRequestId,
      }).exec();
      if (!existing) throw error;
      return toMessage(existing);
    }
  }

  async findMessageByClientRequestId(
    ownerId: string,
    threadId: string,
    role: AppendMessageInput['role'],
    clientRequestId: string,
  ): Promise<ConversationMessage | null> {
    const row = await this.messages.findOne({ ownerId, threadId, role, clientRequestId }).exec();
    return row ? toMessage(row) : null;
  }

  async listRecentMessages(ownerId: string, threadId: string, limit: number): Promise<ConversationMessage[]> {
    const rows = await this.messages.find({ ownerId, threadId })
      .sort({ sequence: -1 })
      .limit(limit)
      .exec();
    return rows.reverse().map(toMessage);
  }

  async listMessagesAfterSequence(
    ownerId: string,
    threadId: string,
    afterSequence: number,
    limit: number,
  ): Promise<ConversationMessage[]> {
    const rows = await this.messages.find({
      ownerId,
      threadId,
      sequence: { $gt: afterSequence },
    }).sort({ sequence: 1 }).limit(limit).exec();
    return rows.map(toMessage);
  }

  async saveSummary(input: SaveConversationSummaryInput): Promise<ConversationThread | null> {
    const summaryGuard = input.expectedThroughSequence === 0
      ? { 'summary.throughSequence': { $exists: false } }
      : { 'summary.throughSequence': input.expectedThroughSequence };
    const row = await this.threads.findOneAndUpdate({
      _id: input.threadId,
      ownerId: input.ownerId,
      status: 'active',
      ...summaryGuard,
    }, {
      $set: {
        summary: {
          content: input.content,
          throughSequence: input.throughSequence,
          updatedAt: new Date(),
        },
      },
    }, { new: true }).exec();
    return row ? toThread(row) : null;
  }
}

function toThread(doc: ConversationThreadDocument & { _id: unknown }): ConversationThread {
  return {
    id: String(doc._id),
    ownerId: doc.ownerId.toString(),
    status: doc.status,
    nextSequence: doc.nextSequence,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    ...(doc.lastMessageAt ? { lastMessageAt: doc.lastMessageAt}: {}),
    ...(doc.title ? { title: doc.title } : {}),
    ...(doc.summary ? {
      summary: {
        content: doc.summary.content,
        throughSequence: doc.summary.throughSequence,
        updatedAt: doc.summary.updatedAt,
      },
    } : {}),
  }
}

function toMessage(doc: ConversationMessageDocument & { _id: unknown }): ConversationMessage {
  return {
    id: String(doc._id),
    ownerId: doc.ownerId.toString(),
    threadId: doc.threadId.toString(),
    sequence: doc.sequence,
    role: doc.role,
    content: doc.content,
    createdAt: doc.createdAt,
    ...(doc.clientRequestId ? { clientRequestId: doc.clientRequestId } : {}),
    ...(typeof doc.inputTokens === 'number' ? { inputTokens: doc.inputTokens } : {}),
    ...(typeof doc.outputTokens === 'number' ? { outputTokens: doc.outputTokens } : {}),
  };
}

function titleFromFirstMessage(content: string): string {
  const normalized = content
    .replace(/\s+/g, ' ')
    .trim();

  return Array.from(normalized)
    .slice(0, 60)
    .join('');
}

function isDuplicateKey(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 11000;
}
