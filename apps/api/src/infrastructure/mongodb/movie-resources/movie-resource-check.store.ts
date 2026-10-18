import type { Model } from 'mongoose';
import type {
  MovieResourceCheckKey,
  MovieResourceCheckCompletion,
  MovieResourceCheckRecord,
  MovieResourceCheckStore,
} from '../../../modules/integrations/movie-resource-check.types.js';
import type { MovieResourceCheckDocument } from './movie-resource-check.schema.js';
import type { MovieResourceCheckTaskDocument } from './movie-resource-check-task.schema.js';

export class MongoMovieResourceCheckStore implements MovieResourceCheckStore {
  constructor(
    private readonly checks: Model<MovieResourceCheckDocument>,
    private readonly tasks: Model<MovieResourceCheckTaskDocument>
  ) {}

  async readForMovies(ownerId: string, tmdbIds: number[]): Promise<MovieResourceCheckRecord[]> {
    if (tmdbIds.length === 0) return [];
    const [rows, tasks] = await Promise.all([
      this.checks.find({ ownerId, tmdbId: { $in: tmdbIds }, provider: 'mteam' }).lean().exec(),
      this.tasks.find({ ownerId, tmdbId: { $in: tmdbIds }, provider: 'mteam', leaseExpiresAt: { $gt: new Date() } }).lean().exec(),
    ]);
    const checkingIds = new Set(tasks.map((task) => task.tmdbId));
    const results: MovieResourceCheckRecord[] = rows.map((row) => ({
      ownerId: String(row.ownerId),
      tmdbId: row.tmdbId,
      provider: 'mteam',
      checking: checkingIds.has(row.tmdbId),
      availability: row.availability ?? 'unchecked',
      ...(row.matchedBy ? { matchedBy: row.matchedBy } : {}),
      ...(row.checkedAt ? { checkedAt: row.checkedAt } : {}),
      ...(row.expiresAt ? { expiresAt: row.expiresAt } : {}),
      ...(row.lastAttemptAt ? { lastAttemptAt: row.lastAttemptAt } : {}),
      ...(row.lastAttemptStatus ? { lastAttemptStatus: row.lastAttemptStatus } : {}),
      ...(row.lastErrorCode ? { lastErrorCode: row.lastErrorCode } : {}),
      ...(row.identityFingerprint ? { identityFingerprint: row.identityFingerprint } : {}),
    }));
    const resultIds = new Set(results.map((result) => result.tmdbId));
    for (const task of tasks) {
      if (!resultIds.has(task.tmdbId)) {
        results.push({ ownerId, tmdbId: task.tmdbId, provider: 'mteam', checking: true, availability: 'unchecked' });
      }
    }
    return results;
  }

  async readOne(key: MovieResourceCheckKey): Promise<MovieResourceCheckRecord | null> {
    const [row, task] = await Promise.all([
      this.checks.findOne(key).lean().exec(),
      this.tasks.findOne({ ...key, leaseExpiresAt: { $gt: new Date() } }).lean().exec(),
    ]);
    if (!row) {
      return task ? { ...key, availability: 'unchecked', checking: true } : null;
    }
    return {
      ownerId: String(row.ownerId), tmdbId: row.tmdbId, provider: 'mteam', checking: Boolean(task),
      availability: row.availability ?? 'unchecked',
      ...(row.matchedBy ? { matchedBy: row.matchedBy } : {}),
      ...(row.checkedAt ? { checkedAt: row.checkedAt } : {}),
      ...(row.expiresAt ? { expiresAt: row.expiresAt } : {}),
      ...(row.lastAttemptAt ? { lastAttemptAt: row.lastAttemptAt } : {}),
      ...(row.lastAttemptStatus ? { lastAttemptStatus: row.lastAttemptStatus } : {}),
      ...(row.lastErrorCode ? { lastErrorCode: row.lastErrorCode } : {}),
      ...(row.identityFingerprint ? { identityFingerprint: row.identityFingerprint } : {}),
    };
  }

  async tryAcquire(
    key: MovieResourceCheckKey,
    attemptedAt: Date,
    leaseExpiresAt: Date,
    failedAttemptBefore: Date,
    identityFingerprint: string | undefined,
    credentialsVerifiedAt: Date | undefined,
    force: boolean,
  ): Promise<boolean> {
    if (!await this.isDue(
      key, attemptedAt, failedAttemptBefore, identityFingerprint, credentialsVerifiedAt, force,
    )) return false;

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
      {
        ...key,
        $or: [
          { lastAttemptAt: { $exists: false } },
          { lastAttemptAt: { $lte: attemptedAt } },
        ],
      },
      result.lastAttemptStatus === 'success'
        ? {
            $set: { ...result, lastAttemptAt: attemptedAt },
            $unset: {
              lastErrorCode: 1,
              ...(!('matchedBy' in result) ? { matchedBy: 1 } : {}),
              ...(!('expiresAt' in result) ? { expiresAt: 1 } : {}),
              ...(!('identityFingerprint' in result) ? { identityFingerprint: 1 } : {}),
            },
          }
        : { $set: { ...result, lastAttemptAt: attemptedAt } },
    ).exec();
    if (result.lastAttemptStatus === 'error') await this.backfillMissingAvailability(key);
  }

  async recordAttempt(
    key: MovieResourceCheckKey,
    attemptedAt: Date,
    result: MovieResourceCheckCompletion,
  ): Promise<void> {
    const update = result.lastAttemptStatus === 'success'
      ? {
          $set: { ...result, lastAttemptAt: attemptedAt },
          $unset: {
            lastErrorCode: 1,
            ...(!('matchedBy' in result) ? { matchedBy: 1 } : {}),
            ...(!('expiresAt' in result) ? { expiresAt: 1 } : {}),
            ...(!('identityFingerprint' in result) ? { identityFingerprint: 1 } : {}),
          },
          $setOnInsert: { ...key },
        }
      : {
          $set: { ...result, lastAttemptAt: attemptedAt },
          $setOnInsert: { ...key, availability: 'unchecked' as const },
        };
    try {
      await this.checks.updateOne(
        {
          ...key,
          $or: [
            { lastAttemptAt: { $exists: false } },
            { lastAttemptAt: { $lte: attemptedAt } },
          ],
        },
        update,
        { upsert: true },
      ).exec();
      if (result.lastAttemptStatus === 'error') await this.backfillMissingAvailability(key);
    } catch (error) {
      // A newer result can win the unique-key race between app instances.
      if (!isDuplicateKeyError(error)) throw error;
    }
  }

  private async isDue(
    key: MovieResourceCheckKey,
    attemptedAt: Date,
    failedAttemptBefore: Date,
    identityFingerprint: string | undefined,
    credentialsVerifiedAt: Date | undefined,
    force: boolean,
  ): Promise<boolean> {
    const state = await this.checks.findOne(key).lean().exec();
    if (!state || !state.lastAttemptAt) return true;
    if (state.lastAttemptStatus === 'error' && state.lastErrorCode === 'authentication') {
      return Boolean(credentialsVerifiedAt && credentialsVerifiedAt > state.lastAttemptAt);
    }
    if (force) return true;
    if (state.lastAttemptStatus === 'error') {
      return ['network', 'timeout', 'rate_limited', 'remote_error', 'internal_error'].includes(state.lastErrorCode ?? '')
        && state.lastAttemptAt <= failedAttemptBefore;
    }
    if (state.availability === 'unmatchable') {
      return Boolean(identityFingerprint && state.identityFingerprint !== identityFingerprint);
    }
    if (state.expiresAt && state.expiresAt <= attemptedAt) return true;
    return false;
  }

  private async releaseTask(key: MovieResourceCheckKey, attemptedAt: Date): Promise<void> {
    await this.tasks.deleteOne({ ...key, attemptedAt }).exec();
  }

  private async backfillMissingAvailability(key: MovieResourceCheckKey): Promise<void> {
    await this.checks.updateOne(
      { ...key, availability: { $exists: false } },
      { $set: { availability: 'unchecked' } },
    ).exec();
  }
}

function isDuplicateKeyError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as { code?: unknown }).code === 11000;
}
