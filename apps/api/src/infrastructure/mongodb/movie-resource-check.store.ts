import type { Model } from 'mongoose';
import type {
  MovieResourceCheckKey,
  MovieResourceCheckCompletion,
  MovieResourceCheckStore,
} from '../../modules/integrations/movie-resource-check.types.js';
import type { MovieResourceCheckDocument } from './movie-resource-check.schema.js';
import type { MovieResourceCheckTaskDocument } from './movie-resource-check-task.schema.js';

export class MongoMovieResourceCheckStore implements MovieResourceCheckStore {
  constructor(
    private readonly checks: Model<MovieResourceCheckDocument>,
    private readonly tasks: Model<MovieResourceCheckTaskDocument>,
  ) {}

  async tryAcquire(
    key: MovieResourceCheckKey,
    attemptedAt: Date,
    leaseExpiresAt: Date,
    failedAttemptBefore: Date,
    force: boolean,
  ): Promise<boolean> {
    if (!force && !await this.isDue(key, attemptedAt, failedAttemptBefore)) return false;

    try {
      const acquired = await this.tasks.findOneAndUpdate(
        {
          ...key,
          $or: [
            { leaseExpiresAt: { $exists: false } },
            { leaseExpiresAt: { $lte: attemptedAt } },
          ],
        },
        {
          $setOnInsert: { ...key },
          $set: { status: 'checking', attemptedAt, leaseExpiresAt },
        },
        { upsert: true, returnDocument: 'after' },
      ).lean().exec();
      if (!acquired) return false;
      try {
        await this.checks.updateOne(
          key,
          { $setOnInsert: { ...key, availability: 'unchecked' } },
          { upsert: true },
        ).exec();
        return true;
      } catch (error) {
        await this.releaseTask(key, attemptedAt);
        throw error;
      }
    } catch (error) {
      // An upsert that loses a race against the unique task key reports E11000.
      if (isDuplicateKeyError(error)) return false;
      throw error;
    }
  }

  async complete(
    key: MovieResourceCheckKey,
    attemptedAt: Date,
    result: MovieResourceCheckCompletion,
  ): Promise<void> {
    const task = await this.tasks.findOneAndDelete({ ...key, attemptedAt }).lean().exec();
    if (!task) return;
    await this.checks.updateOne(
      key,
      result.lastAttemptStatus === 'success'
        ? {
            $set: { ...result, lastAttemptAt: attemptedAt },
            $unset: {
              lastErrorCode: 1,
              ...(!('matchedBy' in result) ? { matchedBy: 1 } : {}),
            },
          }
        : { $set: { ...result, lastAttemptAt: attemptedAt } },
    ).exec();
  }

  private async isDue(
    key: MovieResourceCheckKey,
    attemptedAt: Date,
    failedAttemptBefore: Date,
  ): Promise<boolean> {
    const state = await this.checks.findOne(key).lean().exec();
    if (!state || !state.lastAttemptAt) return true;
    if (state.expiresAt && state.expiresAt <= attemptedAt) return true;
    return state.lastAttemptStatus === 'error'
      && ['network', 'timeout', 'remote_error'].includes(state.lastErrorCode ?? '')
      && state.lastAttemptAt <= failedAttemptBefore;
  }

  private async releaseTask(key: MovieResourceCheckKey, attemptedAt: Date): Promise<void> {
    await this.tasks.deleteOne({ ...key, attemptedAt }).exec();
  }
}

function isDuplicateKeyError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as { code?: unknown }).code === 11000;
}
