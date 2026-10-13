import type { MovieResourceSyncBatch } from '@movie-hub/contract';
import { AppError } from '../../infrastructure/http/app-error.js';
import type { MovieStatusStore } from '../movies/movie.types.js';
import type { MovieResourceCheckService } from './movie-resource-check.service.js';
import type {
  MovieResourceCheckCompletion, MovieResourceCheckRecord, MovieResourceCheckStore,
} from './movie-resource-check.types.js';
import type {
  MovieResourceSyncBatchStore, StoredMovieResourceSyncBatch, SyncCounter,
} from './movie-resource-sync.types.js';

interface SyncLogger {
  info(bindings: Record<string, unknown>, message: string): void;
  error(bindings: Record<string, unknown>, message: string): void;
}

export class MovieResourceSyncService {
  private readonly running = new Set<string>();

  constructor(
    private readonly statuses: MovieStatusStore,
    private readonly checks: Pick<MovieResourceCheckStore, 'readForMovies' | 'readOne'>,
    private readonly checker: MovieResourceCheckService,
    private readonly batches: MovieResourceSyncBatchStore,
    private readonly retryDelayMs: number,
    private readonly busyWaitMs: number,
    private readonly logger: SyncLogger,
    private readonly now: () => Date = () => new Date(),
    private readonly wait: (milliseconds: number) => Promise<void> = (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
  ) {}

  async start(ownerId: string, force = false): Promise<MovieResourceSyncBatch> {
    const active = await this.batches.readCurrent(ownerId);
    if (active && ['queued', 'running', 'paused'].includes(active.status)) {
      this.run(active);
      return publicBatch(active);
    }

    const interestedIds = await this.readAllInterestedIds(ownerId);
    const checks = await this.checks.readForMovies(ownerId, interestedIds);
    const checkById = new Map(checks.map((check) => [check.tmdbId, check]));
    const now = this.now();
    const retryBefore = new Date(now.getTime() - this.retryDelayMs);
    const prioritized = interestedIds
      .map((tmdbId) => ({ tmdbId, priority: priority(checkById.get(tmdbId), now, retryBefore, force) }))
      .filter((item): item is { tmdbId: number; priority: number } => item.priority !== null)
      .sort((left, right) => left.priority - right.priority)
      .map(({ tmdbId }) => tmdbId);
    const batch = await this.batches.createOrGetActive(ownerId, prioritized, force, now);
    this.run(batch);
    return publicBatch(batch);
  }

  async current(ownerId: string): Promise<MovieResourceSyncBatch | null> {
    const batch = await this.batches.readCurrent(ownerId);
    return batch ? publicBatch(batch) : null;
  }

  async get(ownerId: string, id: string): Promise<MovieResourceSyncBatch> {
    const batch = await this.batches.read(ownerId, id);
    if (!batch) throw new AppError(404, 'MTEAM_SYNC_NOT_FOUND', 'M-Team sync job was not found.');
    return publicBatch(batch);
  }

  async resumePending(): Promise<void> {
    for (const batch of await this.batches.readRecoverable()) this.run(batch);
  }

  private run(batch: StoredMovieResourceSyncBatch): void {
    if (!['queued', 'running', 'paused'].includes(batch.status) || this.running.has(batch.id)) return;
    const delay = batch.status === 'paused' && batch.resumeAt
      ? Math.max(0, new Date(batch.resumeAt).getTime() - this.now().getTime())
      : 0;
    this.running.add(batch.id);
    setTimeout(() => {
      void this.process(batch).catch((error) => {
        this.logger.error({ err: error, batchId: batch.id, ownerId: batch.ownerId }, 'Movie resource sync batch crashed');
        return this.batches.finish(batch.id, 'failed');
      }).finally(() => this.running.delete(batch.id));
    }, delay);
  }

  private async process(batch: StoredMovieResourceSyncBatch): Promise<void> {
    await this.batches.setRunning(batch.id);
    this.logger.info({ batchId: batch.id, ownerId: batch.ownerId, total: batch.total }, 'Movie resource sync batch started');
    for (let index = batch.cursor; index < batch.movieIds.length; index += 1) {
      const tmdbId = batch.movieIds[index];
      if (!tmdbId) continue;
      const execution = await this.checker.checkNowDetailed(batch.ownerId, tmdbId, batch.force);
      const result = execution.started ? execution.result : await this.waitForExistingCheck(batch.ownerId, tmdbId);
      if (result.lastAttemptStatus === 'error' && result.lastErrorCode === 'authentication') {
        await this.batches.finish(batch.id, 'failed', 'update_api_key');
        return;
      }
      if (result.lastAttemptStatus === 'error' && result.lastErrorCode === 'rate_limited') {
        if (batch.rateLimitRetries >= 2) {
          await this.batches.advance(batch.id, 'failed');
          await this.batches.finish(batch.id, 'failed');
          return;
        }
        const resumeAt = new Date(this.now().getTime() + this.retryDelayMs);
        const nextRateLimitRetries = batch.rateLimitRetries + 1;
        await this.batches.pause(batch.id, resumeAt);
        setTimeout(() => this.run({
          ...batch, cursor: index, status: 'paused', resumeAt: resumeAt.toISOString(),
          rateLimitRetries: nextRateLimitRetries,
        }), this.retryDelayMs);
        return;
      }
      await this.batches.advance(batch.id, counterFor(result));
    }
    await this.batches.finish(batch.id, 'completed');
    this.logger.info({ batchId: batch.id, ownerId: batch.ownerId, total: batch.total }, 'Movie resource sync batch completed');
  }

  private async waitForExistingCheck(ownerId: string, tmdbId: number): Promise<MovieResourceCheckCompletion> {
    const deadline = Date.now() + this.busyWaitMs;
    do {
      const record = await this.checks.readOne({ ownerId, tmdbId, provider: 'mteam' });
      if (record && !record.checking && record.lastAttemptStatus) return completionFromRecord(record);
      await this.wait(Math.min(250, Math.max(0, deadline - Date.now())));
    } while (Date.now() < deadline);
    return { lastAttemptStatus: 'error', lastErrorCode: 'internal_error' };
  }

  private async readAllInterestedIds(ownerId: string): Promise<number[]> {
    const ids: number[] = [];
    const pageSize = 500;
    for (let page = 1; ; page += 1) {
      const result = await this.statuses.list(ownerId, 'interested', page, pageSize);
      ids.push(...result.items.map(({ tmdbId }) => tmdbId));
      if (ids.length >= result.total || result.items.length === 0) return [...new Set(ids)];
    }
  }
}

function priority(
  check: MovieResourceCheckRecord | undefined,
  now: Date,
  retryBefore: Date,
  force: boolean,
): number | null {
  if (!check) return 0;
  if (check.lastAttemptStatus === 'error') {
    // The checker skips the API call while credentials remain invalid and resumes
    // after a newer verified configuration is saved.
    if (check.lastErrorCode === 'authentication') return 1;
    if (['network', 'timeout', 'rate_limited', 'remote_error', 'internal_error'].includes(check.lastErrorCode ?? '')
      && (!check.lastAttemptAt || check.lastAttemptAt <= retryBefore)) return 2;
    return force ? 3 : null;
  }
  if (!check.checkedAt) return 0;
  // Let the checker compare current movie metadata with the stored fingerprint.
  if (check.availability === 'unmatchable') return 1;
  if (check.expiresAt && check.expiresAt <= now) return 1;
  return force ? 3 : null;
}

function completionFromRecord(record: MovieResourceCheckRecord): MovieResourceCheckCompletion {
  if (record.lastAttemptStatus === 'error') {
    return { lastAttemptStatus: 'error', lastErrorCode: record.lastErrorCode ?? 'internal_error' };
  }
  if (!record.checkedAt || record.availability === 'unchecked') {
    return { lastAttemptStatus: 'error', lastErrorCode: 'internal_error' };
  }
  return record.availability === 'unmatchable'
    ? record.identityFingerprint
      ? { lastAttemptStatus: 'success', availability: 'unmatchable', checkedAt: record.checkedAt, identityFingerprint: record.identityFingerprint }
      : { lastAttemptStatus: 'error', lastErrorCode: 'internal_error' }
    : {
        lastAttemptStatus: 'success', availability: record.availability, matchedBy: 'imdb',
        checkedAt: record.checkedAt, expiresAt: record.expiresAt!,
      };
}

function counterFor(result: MovieResourceCheckCompletion): SyncCounter {
  return result.lastAttemptStatus === 'error' ? 'failed' : result.availability;
}

function publicBatch(batch: StoredMovieResourceSyncBatch): MovieResourceSyncBatch {
  return {
    id: batch.id, status: batch.status, total: batch.total, completed: batch.completed,
    available: batch.available, unavailable: batch.unavailable, unmatchable: batch.unmatchable,
    failed: batch.failed, createdAt: batch.createdAt, updatedAt: batch.updatedAt,
    ...(batch.resumeAt ? { resumeAt: batch.resumeAt } : {}),
    ...(batch.needsAction ? { needsAction: batch.needsAction } : {}),
  };
}
