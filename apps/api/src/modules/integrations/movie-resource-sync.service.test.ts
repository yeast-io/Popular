import assert from 'node:assert/strict';
import test from 'node:test';
import type { MovieStatusStore } from '../movies/movie.types.js';
import type { MovieResourceBatchChecker } from './movie-site-resources.types.js';
import type { MovieResourceCheckExecution } from './movie-resource-check.types.js';
import type { MovieResourceCheckRecord, MovieResourceCheckStore } from './movie-resource-check.types.js';
import { MovieResourceSyncService } from './movie-resource-sync.service.js';
import type {
  MovieResourceSyncBatchStore,
  StoredMovieResourceSyncBatch,
  SyncCounter,
} from './movie-resource-sync.types.js';

const now = new Date('2026-10-13T00:00:00.000Z');

class MemoryBatchStore implements MovieResourceSyncBatchStore {
  batch: StoredMovieResourceSyncBatch | null = null;
  creates = 0;
  pauses = 0;

  async createOrGetActive(ownerId: string, movieIds: number[], force: boolean, _now?: Date, sites?: string[]) {
    if (this.batch && ['queued', 'running', 'paused'].includes(this.batch.status)) return this.batch;
    this.creates += 1;
    this.batch = {
      id: `batch-${this.creates}`,
      ownerId,
      movieIds,
      ...(sites ? { sites: [...sites] } : {}),
      cursor: 0,
      force,
      rateLimitRetries: 0,
      status: movieIds.length ? 'queued' : 'completed',
      total: movieIds.length,
      completed: 0,
      available: 0,
      unavailable: 0,
      unmatchable: 0,
      failed: 0,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    return this.batch;
  }

  async readCurrent() {
    return this.batch;
  }

  async read(ownerId: string, id: string) {
    return this.batch?.ownerId === ownerId && this.batch.id === id ? this.batch : null;
  }

  async readRecoverable() {
    return this.batch ? [this.batch] : [];
  }

  async setRunning() {
    if (this.batch) this.batch.status = 'running';
  }

  async advance(_id: string, counter: SyncCounter) {
    if (!this.batch) return;
    this.batch.cursor += 1;
    this.batch.completed += 1;
    this.batch[counter] += 1;
  }

  async pause(_id: string, resumeAt: Date) {
    if (!this.batch) return;
    this.pauses += 1;
    this.batch.rateLimitRetries += 1;
    this.batch.status = 'paused';
    this.batch.resumeAt = resumeAt.toISOString();
  }

  async finish(_id: string, status: 'completed' | 'failed', needsAction?: 'update_api_key') {
    if (!this.batch) return;
    this.batch.status = status;
    if (needsAction) this.batch.needsAction = needsAction;
  }
}

function harness(
  records: MovieResourceCheckRecord[],
  execute: (tmdbId: number, call: number) => MovieResourceCheckExecution,
  readOne: () => Promise<MovieResourceCheckRecord | null> = async () => null,
  ids = [1, 2, 3, 4]
) {
  const statuses = {
    list: async (_ownerId: string, _status: string, page: number) => {
      return {
        items: page === 1 ? ids.map((tmdbId) => ({ tmdbId, status: 'interested' as const, updatedAt: now })) : [],
        total: ids.length,
      };
    },
  } as unknown as MovieStatusStore;
  const checks = {
    readForMovies: async () => records,
    readOne,
  } as unknown as MovieResourceCheckStore;
  const calls: number[] = [];
  const callCounts = new Map<number, number>();
  const checker = {
    checkNowDetailed: async (_ownerId: string, tmdbId: number) => {
      calls.push(tmdbId);
      const count = (callCounts.get(tmdbId) ?? 0) + 1;
      callCounts.set(tmdbId, count);
      return execute(tmdbId, count);
    },
  } as unknown as MovieResourceBatchChecker;
  const batches = new MemoryBatchStore();
  const waits: number[] = [];
  const service = new MovieResourceSyncService(
    statuses,
    checks,
    checker,
    batches,
    5,
    5,
    { info: () => undefined, error: () => undefined },
    () => now,
    async (milliseconds) => {
      waits.push(milliseconds);
      await new Promise((resolve) => setTimeout(resolve, milliseconds));
    });
  return { batches, calls, service, waits, checker };
}

test('sync includes only never checked movies and movies last checked more than 30 days ago', async () => {
  const records: MovieResourceCheckRecord[] = [
    successful(2, 'unavailable', new Date('2026-09-12T23:59:59.999Z')),
    successful(3, 'available', new Date('2026-09-13T00:00:00.000Z')),
    {
      ...successful(4, 'available', new Date('2026-10-12T00:00:00.000Z')),
      lastAttemptStatus: 'error',
      lastErrorCode: 'timeout',
      lastAttemptAt: now,
    },
  ];
  const { batches, calls, service } = harness(records, () => {
    return {
      started: true,
      result: {
        lastAttemptStatus: 'success',
        availability: 'available',
        matchedBy: 'imdb',
        checkedAt: now,
        expiresAt: new Date('2026-10-14T00:00:00.000Z'),
      },
    };
  });

  await service.start('owner-a');
  await eventually(() => batches.batch?.status === 'completed');

  assert.deepEqual(calls, [1, 2]);
  assert.equal(batches.batch?.total, 2);
  assert.equal(batches.batch?.available, 2);
  assert.equal(batches.batch?.force, true);
});

test('sync does not wait when no other check task exists for an incomplete legacy result', async () => {
  const incomplete: MovieResourceCheckRecord = {
    ownerId: 'owner-a',
    tmdbId: 1,
    provider: 'mteam',
    checking: false,
    availability: 'unchecked',
    lastAttemptAt: new Date('2026-10-12T00:00:00.000Z'),
    lastErrorCode: 'invalid_response',
  };
  const { batches, service, waits } = harness(
    [incomplete],
    () => ({ started: false }),
    async () => incomplete,
    [1]
  );

  await service.start('owner-a');
  await eventually(() => batches.batch?.status === 'completed');

  assert.deepEqual(waits, []);
  assert.equal(batches.batch?.failed, 1);
});

test('a second start returns the same active batch instead of creating duplicate work', async () => {
  const { batches, service } = harness([], () => {
    return {
      started: true,
      result: {
        lastAttemptStatus: 'success',
        availability: 'unmatchable',
        checkedAt: now,
        identityFingerprint: '["Movie",null]',
      },
    };
  });
  const first = await service.start('owner-a');
  const second = await service.start('owner-a');

  assert.equal(first.id, second.id);
  assert.equal(batches.creates, 1);
  await eventually(() => batches.batch?.status === 'completed');
});

test('authentication failure stops the batch and requests an API key update', async () => {
  const { batches, calls, service } = harness([], () => {
    return {
      started: true,
      result: { lastAttemptStatus: 'error', lastErrorCode: 'authentication' },
    };
  });
  await service.start('owner-a');
  await eventually(() => batches.batch?.status === 'failed');

  assert.deepEqual(calls, [1]);
  assert.equal(batches.batch?.needsAction, 'update_api_key');
});

test('rate limiting pauses instead of tight-looping and later resumes the same item', async () => {
  let limited = false;
  const { batches, calls, service } = harness([], () => {
    if (!limited) {
      limited = true;
      return { started: true, result: { lastAttemptStatus: 'error', lastErrorCode: 'rate_limited' } };
    }
    return {
      started: true,
      result: {
        lastAttemptStatus: 'success',
        availability: 'unavailable',
        matchedBy: 'imdb',
        checkedAt: now,
        expiresAt: new Date('2026-10-14T00:00:00.000Z'),
      },
    };
  });
  await service.start('owner-a');
  await eventually(() => batches.batch?.status === 'completed');

  assert.equal(batches.pauses, 1);
  assert.deepEqual(calls.slice(0, 2), [1, 1]);
});

test('persistent rate limiting stops after three delayed attempts', async () => {
  const { batches, calls, service } = harness([], () => {
    return {
      started: true,
      result: { lastAttemptStatus: 'error', lastErrorCode: 'rate_limited' },
    };
  });
  await service.start('owner-a');
  await eventually(() => batches.batch?.status === 'failed');

  assert.equal(batches.pauses, 2);
  assert.deepEqual(calls, [1, 1, 1]);
  assert.equal(batches.batch?.failed, 1);
});

test('sync job lookup is isolated by authenticated owner', async () => {
  const { batches, service } = harness([], () => {
    return {
      started: true,
      result: { lastAttemptStatus: 'error', lastErrorCode: 'internal_error' },
    };
  });
  await service.start('owner-a');

  assert.equal((await service.get('owner-a', batches.batch!.id)).id, batches.batch!.id);
  await assert.rejects(() => service.get('owner-b', batches.batch!.id), {
    statusCode: 404,
    code: 'MTEAM_SYNC_NOT_FOUND',
  }
  );
});

function successful(
  tmdbId: number,
  availability: 'available' | 'unavailable',
  checkedAt: Date
): MovieResourceCheckRecord {
  return {
    ownerId: 'owner-a',
    tmdbId,
    provider: 'mteam',
    checking: false,
    availability,
    checkedAt,
    expiresAt: new Date(checkedAt.getTime() + 24 * 60 * 60 * 1_000),
    lastAttemptAt: checkedAt,
    lastAttemptStatus: 'success',
    matchedBy: 'imdb',
  };
}

async function eventually(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition was not met');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('shutdown cancels queued batch timers and preserves batches for startup recovery', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness([], () => {
    return { started: true, result: { lastAttemptStatus: 'error', lastErrorCode: 'internal_error' } };
  });
  await h.service.start('alice');
  await h.service.stop();
  context.mock.timers.tick(60_000);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(h.calls.length, 0);
  assert.equal(h.batches.batch?.status, 'queued');
});

test('multi-site batches persist the launch selection and include a film whose other source has not been checked', async () => {
  const f = harness(
    [successful(1, 'available', now)],
    () => ({ started: true, result: { lastAttemptStatus: 'error', lastErrorCode: 'remote_error' } }),
    undefined,
    [1]
  );
  let selected = ['mteam', 'hdarea'];
  const observed: string[][] = [];
  f.checker.selectedSites = async () => selected;
  f.checker.checkNowDetailed = async (_owner, _movie, _force, sites) => {
    observed.push([...(sites ?? [])]);
    return { started: true, result: { lastAttemptStatus: 'error', lastErrorCode: 'authentication' } };
  };
  await f.service.start('owner-a');
  selected = ['hdarea'];
  await eventually(() => f.batches.batch?.status === 'completed');
  assert.deepEqual(f.batches.batch?.movieIds, [1]);
  assert.deepEqual(f.batches.batch?.sites, ['mteam', 'hdarea']);
  assert.deepEqual(observed, [['mteam', 'hdarea']]);
  assert.equal(f.batches.batch?.failed, 1);
  await f.service.stop();
});
