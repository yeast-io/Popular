import type { Model } from 'mongoose';
import type { TelegramBindingDocument } from './telegram.schema.js';
import type { TelegramStore, TelegramRecord } from '../../../modules/telegram/telegram.service.js';

const duplicate = (error: unknown): boolean => {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 11000;
};
export class MongoTelegramStore implements TelegramStore {
  constructor(
    private readonly model: Model<TelegramBindingDocument>
  ) {}
  async findOwnerByChatId(chatId: string): Promise<string | null> {
    const row = await this.model.findOne({ chatId }).select('ownerId').lean().exec();
    return row ? String(row.ownerId) : null;
  }
  async find(ownerId: string): Promise<TelegramRecord | null> {
    const row = await this.model.findOne({ ownerId }).lean().exec();
    return row
      ? {
          ...(row.chatId ? { chatId: row.chatId } : {}),
          ...(row.account ? { account: row.account } : {}),
          ...(row.expiresAt ? { expiresAt: row.expiresAt } : {}),
        }
      : null;
  }
  async pending(ownerId: string, pendingHash: string, expiresAt: Date): Promise<boolean> {
    try {
      await this.model
        .updateOne({ ownerId, chatId: { $exists: false } }, { $set: { pendingHash, expiresAt } }, { upsert: true })
        .exec();
      return true;
    } catch (error) {
      if (duplicate(error)) return false;
      throw error;
    }
  }
  async consume(pendingHash: string, chatId: string, account: string, now: Date): Promise<boolean> {
    try {
      const result = await this.model
        .updateOne(
          { pendingHash, expiresAt: { $gt: now }, chatId: { $exists: false } },
          { $set: { chatId, account }, $unset: { pendingHash: 1, expiresAt: 1 } },
        )
        .exec();
      return result.modifiedCount === 1;
    } catch (error) {
      if (duplicate(error)) return false;
      throw error;
    }
  }
  async reserveTest(ownerId: string, chatId: string, now: Date): Promise<boolean> {
    const result = await this.model
      .updateOne(
        {
          ownerId,
          chatId,
          $or: [{ lastTestAt: { $exists: false } }, { lastTestAt: { $lte: new Date(now.getTime() - 30_000) } }],
        },
        { $set: { lastTestAt: now } },
      )
      .exec();
    return result.modifiedCount === 1;
  }
  async remove(ownerId: string): Promise<void> {
    await this.model.deleteOne({ ownerId }).exec();
  }
}
