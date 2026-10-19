import type { MovieResourceSyncBatch } from '@movie-hub/contract';
import { AppError } from '../../infrastructure/http/app-error.js';
import type { MovieStatusStore } from '../movies/movie.types.js';
import type { MovieResourceCheckService } from './movie-resource-check.service.js';
import type {
  MovieResourceCheckCompletion,
  MovieResourceCheckRecord,
  MovieResourceCheckStore,
} from './movie-resource-check.types.js';
import type {
  MovieResourceSyncBatchStore,
  StoredMovieResourceSyncBatch,
  SyncCounter,
} from './movie-resource-sync.types.js';

interface SyncLogger {
  info(bindings: Record<string, unknown>, message: string): void;
  error(bindings: Record<string, unknown>, message: string): void;
}

export class MovieResourceSyncService {
  private readonly running = new Set<string>();
  private readonly tasks = new Set<Promise<void>>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private stopped = false;
  private static readonly STALE_CHECK_AGE_MS = 30 * 24 * 60 * 60 * 1_000;

  constructor(
    private readonly statuses: MovieStatusStore,
    private readonly checks: Pick<MovieResourceCheckStore, 'readForMovies' | 'readOne'>,
    private readonly checker: MovieResourceCheckService,
    private readonly batches: MovieResourceSyncBatchStore,
    private readonly retryDelayMs: number,
    private readonly busyWaitMs: number,
    private readonly logger: SyncLogger,
    private readonly now: () => Date = () => new Date(),
    private readonly wait: (milliseconds: number) => Promise<void> = (milliseconds) => {
      return new Promise((resolve) => setTimeout(resolve, milliseconds));
    }
  ) {}

  async start(ownerId: string): Promise<MovieResourceSyncBatch> {
    const active = await this.batches.readCurrent(ownerId);
    if (active && ['queued', 'running', 'paused'].includes(active.status)) {
      this.run(active);
      return publicBatch(active);
    }

    const interestedIds = await this.readAllInterestedIds(ownerId);
    const checks = await this.checks.readForMovies(ownerId, interestedIds);
    const checkById = new Map(checks.map((check) => [check.tmdbId, check]));
    const now = this.now();
    const staleBefore = new Date(now.getTime() - MovieResourceSyncService.STALE_CHECK_AGE_MS);
    const prioritized = interestedIds
      .map((tmdbId) => ({ tmdbId, priority: priority(checkById.get(tmdbId), staleBefore) }))
      .filter((item): item is { tmdbId: number; priority: number } => item.priority !== null)
      .sort((left, right) => left.priority - right.priority)
      .map(({ tmdbId }) => tmdbId);
    // The batch has already applied its one-month eligibility boundary. Force
    // the selected records so shorter provider TTL/retry rules cannot skip them.
    const batch = await this.batches.createOrGetActive(ownerId, prioritized, true, now);
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
    if (this.stopped || !['queued', 'running', 'paused'].includes(batch.status) || this.running.has(batch.id)) return;
    const delay =
      batch.status === 'paused' && batch.resumeAt
        ? Math.max(0, new Date(batch.resumeAt).getTime() - this.now().getTime())
        : 0;
    this.running.add(batch.id);
    this.schedule(() => {
      const task = this.process(batch)
        .catch((error) => {
          this.logger.error(
            { err: error, batchId: batch.id, ownerId: batch.ownerId },
            'Movie resource sync batch crashed',
          );
          return this.batches.finish(batch.id, 'failed');
        })
        .finally(() => {
          this.running.delete(batch.id);
          this.tasks.delete(task);
        });
      this.tasks.add(task);
    }, delay);
  }

  private schedule(action: () => void, delay: number): void {
    if (this.stopped) return;
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (!this.stopped) action();
    }, delay);
    this.timers.add(timer);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    await Promise.allSettled(this.tasks);
    this.running.clear();
  }

  private async process(batch: StoredMovieResourceSyncBatch): Promise<void> {
    await this.batches.setRunning(batch.id);
    this.logger.info(
      { batchId: batch.id, ownerId: batch.ownerId, total: batch.total },
      'Movie resource sync batch started',
    );
    for (let index = batch.cursor; index < batch.movieIds.length; index += 1) {
      if (this.stopped) return;
      const tmdbId = batch.movieIds[index];
      if (!tmdbId) continue;
      const execution = await this.checker.checkNowDetailed(batch.ownerId, tmdbId, batch.force);
      const result = execution.started ? execution.result : await this.waitForExistingCheck(batch.ownerId, tmdbId);
      if (this.stopped && !execution.started) return;
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
        this.schedule(() => {
          return this.run({
            ...batch,
            cursor: index,
            status: 'paused',
            resumeAt: resumeAt.toISOString(),
            rateLimitRetries: nextRateLimitRetries,
          }
          );
        }, this.retryDelayMs);
        return;
      }
      await this.batches.advance(batch.id, counterFor(result));
    }
    if (this.stopped) return;
    await this.batches.finish(batch.id, 'completed');
    this.logger.info(
      { batchId: batch.id, ownerId: batch.ownerId, total: batch.total },
      'Movie resource sync batch completed',
    );
  }

  private async waitForExistingCheck(ownerId: string, tmdbId: number): Promise<MovieResourceCheckCompletion> {
    const deadline = Date.now() + this.busyWaitMs;
    do {
      const record = await this.checks.readOne({ ownerId, tmdbId, provider: 'mteam' });
      if (!record?.checking) {
        return record?.lastAttemptStatus
          ? completionFromRecord(record)
          : { lastAttemptStatus: 'error', lastErrorCode: 'internal_error' };
      }
      await this.wait(Math.min(250, Math.max(0, deadline - Date.now())));
    } while (!this.stopped && Date.now() < deadline);
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

function priority(check: MovieResourceCheckRecord | undefined, staleBefore: Date): number | null {
  if (!check?.checkedAt) return 0;
  return check.checkedAt < staleBefore ? 1 : null;
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
      ? {
          lastAttemptStatus: 'success',
          availability: 'unmatchable',
          checkedAt: record.checkedAt,
          identityFingerprint: record.identityFingerprint,
        }
      : { lastAttemptStatus: 'error', lastErrorCode: 'internal_error' }
    : {
        lastAttemptStatus: 'success',
        availability: record.availability,
        matchedBy: 'imdb',
        checkedAt: record.checkedAt,
        expiresAt: record.expiresAt!,
      };
}

function counterFor(result: MovieResourceCheckCompletion): SyncCounter {
  return result.lastAttemptStatus === 'error' ? 'failed' : result.availability;
}

function publicBatch(batch: StoredMovieResourceSyncBatch): MovieResourceSyncBatch {
  return {
    id: batch.id,
    status: batch.status,
    total: batch.total,
    completed: batch.completed,
    available: batch.available,
    unavailable: batch.unavailable,
    unmatchable: batch.unmatchable,
    failed: batch.failed,
    createdAt: batch.createdAt,
    updatedAt: batch.updatedAt,
    ...(batch.resumeAt ? { resumeAt: batch.resumeAt } : {}),
    ...(batch.needsAction ? { needsAction: batch.needsAction } : {}),
  };
}
