import type { Model } from 'mongoose';
import type {
  MovieResourceSyncBatchStore,
  StoredMovieResourceSyncBatch,
  SyncCounter,
} from '../../../modules/integrations/movie-resource-sync.types.js';
import type { MovieResourceSyncBatchDocument } from './movie-resource-sync-batch.schema.js';

export class MongoMovieResourceSyncBatchStore implements MovieResourceSyncBatchStore {
  constructor(
    private readonly batches: Model<MovieResourceSyncBatchDocument>
  ) {}

  async createOrGetActive(ownerId: string, movieIds: number[], force: boolean, now: Date) {
    const existing = await this.batches.findOne({ ownerId, active: true }).lean().exec();
    if (existing) return mapBatch(existing);
    try {
      const created = await this.batches.create({
        ownerId,
        status: movieIds.length ? 'queued' : 'completed',
        active: movieIds.length > 0,
        movieIds,
        total: movieIds.length,
        cursor: 0,
        completed: 0,
        available: 0,
        unavailable: 0,
        unmatchable: 0,
        failed: 0,
        force,
        rateLimitRetries: 0,
        createdAt: now,
        updatedAt: now,
      });
      return mapBatch(created.toObject());
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error;
      const winner = await this.batches.findOne({ ownerId, active: true }).lean().exec();
      if (!winner) throw error;
      return mapBatch(winner);
    }
  }

  async readCurrent(ownerId: string) {
    const row = await this.batches.findOne({ ownerId }).sort({ createdAt: -1 }).lean().exec();
    return row ? mapBatch(row) : null;
  }

  async read(ownerId: string, id: string) {
    const row = await this.batches.findOne({ _id: id, ownerId }).lean().exec();
    return row ? mapBatch(row) : null;
  }

  async readRecoverable() {
    const rows = await this.batches
      .find({ active: true, status: { $in: ['queued', 'running', 'paused'] } })
      .lean()
      .exec();
    return rows.map(mapBatch);
  }

  async setRunning(id: string): Promise<void> {
    await this.batches
      .updateOne({ _id: id, active: true }, { $set: { status: 'running' }, $unset: { resumeAt: 1 } })
      .exec();
  }

  async advance(id: string, counter: SyncCounter): Promise<void> {
    await this.batches.updateOne({ _id: id, active: true }, { $inc: { cursor: 1, completed: 1, [counter]: 1 } }).exec();
  }

  async pause(id: string, resumeAt: Date): Promise<void> {
    await this.batches
      .updateOne({ _id: id, active: true }, { $set: { status: 'paused', resumeAt }, $inc: { rateLimitRetries: 1 } })
      .exec();
  }

  async finish(id: string, status: 'completed' | 'failed', needsAction?: 'update_api_key'): Promise<void> {
    await this.batches
      .updateOne(
        { _id: id, active: true },
        {
          $set: { status, active: false, ...(needsAction ? { needsAction } : {}) },
          $unset: { resumeAt: 1 },
        },
      )
      .exec();
  }
}

function mapBatch(row: MovieResourceSyncBatchDocument): StoredMovieResourceSyncBatch {
  return {
    id: String(row._id),
    ownerId: String(row.ownerId),
    status: row.status,
    movieIds: [...row.movieIds],
    cursor: row.cursor,
    force: row.force,
    rateLimitRetries: row.rateLimitRetries ?? 0,
    total: row.total,
    completed: row.completed,
    available: row.available,
    unavailable: row.unavailable,
    unmatchable: row.unmatchable,
    failed: row.failed,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    ...(row.resumeAt ? { resumeAt: row.resumeAt.toISOString() } : {}),
    ...(row.needsAction ? { needsAction: row.needsAction } : {}),
  };
}

function isDuplicateKeyError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 11000;
}
