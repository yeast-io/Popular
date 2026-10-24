import type { Model } from 'mongoose';
import type { TvWatchlistDocument } from './tv-watchlist.schema.js';
import type { TvWatchlistStore } from '../../../modules/watchlist/watchlist.types.js';

export class MongoTvWatchlistStore implements TvWatchlistStore {
  constructor(private readonly model: Model<TvWatchlistDocument>) {}

  async contains(ownerId: string, tmdbId: number): Promise<boolean> {
    return Boolean(await this.model.exists({ ownerId, tmdbId }).exec());
  }

  async add(ownerId: string, tmdbId: number): Promise<void> {
    try {
      await this.model.updateOne({ ownerId, tmdbId }, { $setOnInsert: { ownerId, tmdbId } }, { upsert: true }).exec();
    } catch (error) {
      // Concurrent identical additions must remain idempotent.
      if (!(error instanceof Error && 'code' in error && error.code === 11000)) throw error;
    }
  }

  async remove(ownerId: string, tmdbId: number): Promise<void> {
    await this.model.deleteOne({ ownerId, tmdbId }).exec();
  }

  async list(ownerId: string, page: number, pageSize: number) {
    const [rows, total] = await Promise.all([
      this.model.find({ ownerId }).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * pageSize).limit(pageSize).lean().exec(),
      this.model.countDocuments({ ownerId }).exec(),
    ]);
    return { ids: rows.map((row) => row.tmdbId), total };
  }
}
