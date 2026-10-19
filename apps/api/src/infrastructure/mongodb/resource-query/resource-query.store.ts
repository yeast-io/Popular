import { RESOURCE_QUERY_RETENTION_MS } from '../assistant-retention.js';
import { Schema, type Connection } from 'mongoose';
import { emptyResourceState, type ResourceQueryState, type ResourceQueryStore } from '../../../modules/resource-query/resource-query.types.js';

export function createResourceQueryModel(connection: Connection) {
  const schema = new Schema({
    ownerId: { type: String, required: true },
    conversation: { type: String, required: true },
    data: { type: Schema.Types.Mixed, required: true },
    leaseId: String,
    leaseUntil: Date,
    expiresAt: Date,
  }, { timestamps: true });
  schema.index({ ownerId: 1, conversation: 1 }, { unique: true });
  schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  return connection.model('AssistantResourceQuery', schema);
}
export class MongoResourceQueryStore implements ResourceQueryStore {
  constructor(
    private readonly model: ReturnType<typeof createResourceQueryModel>
  ) {}
  async ensure(ownerId: string, conversation: string): Promise<void> {
    const now = new Date();
    try {
      // Refresh expiry atomically so TTL cannot delete a conversation between ensure and acquire.
      // An expired row may still exist until the TTL monitor runs; discard its old replay receipts.
      await this.model.updateOne(
        { ownerId, conversation },
        [{ $set: {
          ownerId: { $literal: ownerId }, conversation: { $literal: conversation },
          createdAt: { $ifNull: ['$createdAt', now] },
          data: { $cond: [
            { $and: [
              { $eq: [{ $type: '$expiresAt' }, 'date'] }, { $lte: ['$expiresAt', now] },
              { $not: [{ $gt: ['$leaseUntil', now] }] },
            ] },
            { $literal: emptyResourceState() }, { $ifNull: ['$data', { $literal: emptyResourceState() }] },
          ] },
          expiresAt: new Date(now.getTime() + RESOURCE_QUERY_RETENTION_MS),
        } }],
        { upsert: true },
      ).exec();
    } catch (error) {
      if ((error as { code?: number }).code !== 11000) throw error;
    }
  }
  async read(ownerId: string, conversation: string): Promise<ResourceQueryState | null> {
    const row = await this.model.findOne({
      ownerId, conversation,
      $or: [{ expiresAt: { $gt: new Date() } }, { expiresAt: { $exists: false } }],
    }).lean().exec();
    return row ? row.data as ResourceQueryState : null;
  }
  async acquire(ownerId: string, conversation: string, leaseId: string): Promise<boolean> {
    return Boolean(await this.model.findOneAndUpdate(
      { ownerId, conversation, $or: [{ leaseUntil: null }, { leaseUntil: { $lte: new Date() } }] },
      { $set: { leaseId, leaseUntil: new Date(Date.now() + 240_000), expiresAt: new Date(Date.now() + RESOURCE_QUERY_RETENTION_MS) } },
      { returnDocument: 'after' },
    ).lean().exec());
  }
  async save(ownerId: string, conversation: string, leaseId: string, state: ResourceQueryState): Promise<boolean> {
    const result = await this.model.updateOne(
      { ownerId, conversation, leaseId, leaseUntil: { $gt: new Date() } }, { $set: { data: state, expiresAt: new Date(Date.now() + RESOURCE_QUERY_RETENTION_MS) } },
    ).exec();
    return result.matchedCount === 1;
  }
  async release(ownerId: string, conversation: string, leaseId: string): Promise<void> {
    await this.model.updateOne({ ownerId, conversation, leaseId }, { $unset: { leaseId: 1, leaseUntil: 1 }, $set: { expiresAt: new Date(Date.now() + RESOURCE_QUERY_RETENTION_MS) } }).exec();
  }
}
