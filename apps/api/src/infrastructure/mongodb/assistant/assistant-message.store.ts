import { Types } from 'mongoose';
import type { AssistantQueue, AssistantJob, AssistantConversation } from '../../../modules/assistant/assistant.queue.js';
import type { AssistantInputWorkflowMessage, AssistantIntent, AssistantWorkflowResult } from '../../../modules/assistant/assistant.type.js';
import type { LlmMessage } from '../../../modules/llm/llm.types.js';
import type { AssistantMessageModel } from './assistant-message.schema.js';

export class MongoAssistantQueue implements AssistantQueue {
  constructor(
    private readonly model: AssistantMessageModel
  )
  {
  }

  async enqueue(input: AssistantInputWorkflowMessage): Promise<void> {
    const { ownerId, channel, chatId, messageId } = input;
    try {
      await this.model.updateOne({ ownerId: new Types.ObjectId(ownerId), channel, chatId, messageId }, {
        $setOnInsert: { ...input, ownerId: new Types.ObjectId(ownerId), receivedAt: new Date(input.receivedAt),
          status: 'pending', attempts: 0, nextAttemptAt: new Date() },
      }, { upsert: true });
    } catch (error) {
      if ((error as { code?: number }).code !== 11000) throw error;
    }
  }

  async readyConversations(limit: number): Promise<AssistantConversation[]> {
    const now = new Date();
    // Group before filtering due times: a delayed head must block later messages.
    const rows = await this.model.aggregate<{ _id: AssistantConversation }>([
      { $match: { status: { $in: ['pending', 'processing'] } } },
      { $sort: { receivedAt: 1, _id: 1 } },
      { $group: {
        _id: { ownerId: '$ownerId', channel: '$channel', chatId: '$chatId' },
        head: { $first: '$$ROOT' },
      } },
      { $match: { $or: [
        { 'head.status': 'pending', 'head.nextAttemptAt': { $lte: now } },
        { 'head.status': 'processing', 'head.leaseUntil': { $lte: now } },
      ] } },
      { $sort: { 'head.receivedAt': 1, 'head._id': 1 } },
      { $limit: limit },
    ]);
    return rows.map(row => ({ ...row._id, ownerId: String(row._id.ownerId) }));
  }

  async claim(conversation: AssistantConversation, leaseId: string): Promise<AssistantJob | null> {
    const head = await this.model.findOne({
      ownerId: new Types.ObjectId(conversation.ownerId), channel: conversation.channel, chatId: conversation.chatId,
      status: { $in: ['pending', 'processing'] },
    }).sort({ receivedAt: 1, _id: 1 }).select('_id').lean();
    if (!head) return null;
    const now = new Date();
    const row = await this.model.findOneAndUpdate({ _id: head._id, $or: [
      { status: 'pending', nextAttemptAt: { $lte: now } },
      { status: 'processing', leaseUntil: { $lte: now } },
    ] }, { $set: { status: 'processing', leaseId, leaseUntil: new Date(now.getTime() + 60_000) },
      $inc: { attempts: 1 } }, { new: true }).lean();
    if (!row) return null;
    return { id: String(row._id), attempts: row.attempts,
      input: { ownerId: String(row.ownerId), channel: row.channel as AssistantInputWorkflowMessage['channel'],
        chatId: row.chatId, messageId: row.messageId, text: row.text, receivedAt: row.receivedAt.toISOString() },
      ...(row.replyText ? { result: { replyText: row.replyText, ...(row.intent ? { intent: row.intent as AssistantIntent } : {}) } } : {}),
    };
  }

  async renew(id: string, leaseId: string): Promise<boolean> {
    const renewed = await this.model.updateOne(this.owned(id, leaseId), {
      $set: { leaseUntil: new Date(Date.now() + 60_000) },
    });
    return renewed.matchedCount === 1;
  }

  private owned(id: string, leaseId: string) {
    return { _id: id, leaseId, status: 'processing', leaseUntil: { $gt: new Date() } };
  }

  async history(input: AssistantInputWorkflowMessage): Promise<LlmMessage[]> {
    const rows = await this.model.find({ ownerId: new Types.ObjectId(input.ownerId), channel: input.channel,
      chatId: input.chatId, status: 'delivered', receivedAt: { $lte: new Date(input.receivedAt) },
    }).sort({ receivedAt: -1, _id: -1 }).limit(10).lean();
    return rows.reverse().flatMap(row => [
      { role: 'user' as const, content: row.text }, { role: 'assistant' as const, content: row.replyText ?? '' },
    ]);
  }

  async saveResult(id: string, leaseId: string, result: AssistantWorkflowResult): Promise<boolean> {
    const saved = await this.model.updateOne(this.owned(id, leaseId), { $set: result });
    return saved.matchedCount === 1;
  }

  async delivered(id: string, leaseId: string): Promise<void> {
    await this.model.updateOne(this.owned(id, leaseId), {
      $set: { status: 'delivered' }, $unset: { leaseId: 1, leaseUntil: 1 },
    });
  }

  async retry(id: string, leaseId: string, exhausted: boolean): Promise<void> {
    await this.model.updateOne(this.owned(id, leaseId), {
      $set: { status: exhausted ? 'failed' : 'pending', nextAttemptAt: new Date(Date.now() + 15_000) },
      $unset: { leaseId: 1, leaseUntil: 1 },
    });
  }
}
