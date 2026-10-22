import type {
  RecommendationState,
  RecommendationStore,
} from '../../../modules/recommendations/recommendation.types.js';
import { emptyRecommendationState } from '../../../modules/recommendations/recommendation.domain.js';
import type { createRecommendationModel } from './recommendation.schema.js';

export class MongoRecommendationStore implements RecommendationStore {
  constructor(private readonly model: ReturnType<typeof createRecommendationModel>) {}

  async ensure(ownerId: string, conversation: string): Promise<void> {
    const state = emptyRecommendationState();
    try {
      await this.model.updateOne({ ownerId, conversation }, { $setOnInsert: { data: state } }, { upsert: true }).exec();
    } catch (error) {
      if ((error as { code?: number }).code !== 11000) throw error;
    }
  }

  async read(ownerId: string, conversation: string) {
    const row = await this.model.findOne({ ownerId, conversation }).lean().exec();
    return row ? { state: row.data as RecommendationState, updatedAt: row.updatedAt } : null;
  }

  async acquire(ownerId: string, conversation: string, leaseId: string): Promise<boolean> {
    const row = await this.model
      .findOneAndUpdate(
        { ownerId, conversation, $or: [{ leaseUntil: null }, { leaseUntil: { $lte: new Date() } }] },
        { $set: { leaseId, leaseUntil: new Date(Date.now() + 240_000) } },
        { returnDocument: 'after' }
      )
      .lean()
      .exec();
    return Boolean(row);
  }

  async save(ownerId: string, conversation: string, leaseId: string, state: RecommendationState): Promise<boolean> {
    const result = await this.model
      .updateOne({ ownerId, conversation, leaseId, leaseUntil: { $gt: new Date() } }, { $set: { data: state } })
      .exec();
    return result.matchedCount === 1;
  }

  async release(ownerId: string, conversation: string, leaseId: string): Promise<void> {
    await this.model.updateOne({ ownerId, conversation, leaseId }, { $unset: { leaseId: 1, leaseUntil: 1 } }).exec();
  }
}
