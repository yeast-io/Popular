import assert from 'node:assert/strict';
import test from 'node:test';
import type { MovieCatalogStore, MovieDetailRecord, MovieSearchProvider } from '../movies/movie.types.js';
import { IntegrationValidationError } from './integration.service.js';
import type { IntegrationConfigStore } from './integration.types.js';
import { isActiveRelease, MovieResourceCheckService } from './movie-resource-check.service.js';
import type {
  MTeamRelease,
  MTeamResourceSearcher,
  MovieResourceCheckCompletion,
  MovieResourceCheckKey,
  MovieResourceCheckStore,
} from './movie-resource-check.types.js';
import { SecretCrypto } from './secret-crypto.js';

const now = new Date('2026-10-13T00:00:00.000Z');
const secrets = new SecretCrypto('test-resource-secret-key-at-least-32-characters');

class StubCheckStore implements MovieResourceCheckStore {
  acquire = true;
  checking = false;
  acquireCalls: Array<{ key: MovieResourceCheckKey; force: boolean }> = [];
  completed: MovieResourceCheckCompletion[] = [];

  async readForMovies() { return []; }
  async readOne() {
    return this.checking
      ? { ownerId: 'owner-a', tmdbId: 603, provider: 'mteam' as const, checking: true, availability: 'unchecked' as const }
      : null;
  }

  async tryAcquire(
    key: MovieResourceCheckKey,
    _attemptedAt: Date,
    _staleAttemptBefore: Date,
    _failedAttemptBefore: Date,
    _identityFingerprint: string | undefined,
    _credentialsVerifiedAt: Date | undefined,
    force: boolean,
  ) {
    this.acquireCalls.push({ key, force });
    if (!this.acquire || this.checking) return false;
    this.checking = true;
    return true;
  }

  async complete(_key: MovieResourceCheckKey, _attemptedAt: Date, result: MovieResourceCheckCompletion) {
    this.completed.push(result);
    this.checking = false;
  }

  async recordAttempt(_key: MovieResourceCheckKey, _attemptedAt: Date, result: MovieResourceCheckCompletion) {
    this.completed.push(result);
  }
}

class StubMTeam implements MTeamResourceSearcher {
  releases: MTeamRelease[] = [];
  error?: Error;
  queries: Array<{ imdbId: string } | { title: string }> = [];

  async searchMovies(_baseUrl: string, _apiKey: string, query: { imdbId: string } | { title: string }) {
    this.queries.push(query);
    if (this.error) throw this.error;
    return this.releases;
  }
}

function harness(identity: { title: string; imdbId?: string } | null = { title: 'Movie', imdbId: 'tt0133093' }) {
  const checks = new StubCheckStore();
  const mteam = new StubMTeam();
  const encryptedApiKey = secrets.encrypt('api-key', 'movie-hub:integration:mteam:owner:owner-a');
  let lastFailureType: 'authentication' | undefined;
  const configs = {
    find: async () => ({
      ownerId: 'owner-a', provider: 'mteam' as const, baseUrl: 'https://api.m-team.cc', encryptedApiKey,
      ...(lastFailureType ? { lastFailureType } : {}),
    }),
    recordFailure: async (_ownerId: string, _provider: 'mteam', _at: Date, failureType: 'authentication') => {
      lastFailureType = failureType;
    },
  } as unknown as IntegrationConfigStore;
  const writes: MovieDetailRecord[] = [];
  const movies = {
    hasMovie: async () => true,
    readMovieIdentity: async () => identity,
    writeMovieDetail: async (detail: MovieDetailRecord) => { writes.push(detail); },
  } as unknown as MovieCatalogStore;
  const detail: MovieDetailRecord = {
    tmdbId: 603,
    title: 'The Matrix',
    genreIds: [],
    genres: [],
    cast: [],
    directors: [],
  };
  const tmdb = { fetchDetails: async () => detail } as unknown as MovieSearchProvider;
  const service = new MovieResourceCheckService(
    checks,
    configs,
    secrets,
    mteam,
    movies,
    tmdb,
    'en-US',
    {
      availableTtlMs: 86_400_000, unavailableTtlMs: 21_600_000, retryDelayMs: 900_000,
      leaseMs: 120_000, minimumIntervalMs: 0, releaseListTtlMs: 120_000,
    },
    { info: () => undefined, error: () => undefined },
    () => now,
  );
  return { checks, detail, mteam, service, writes };
}

test('consecutive manual requests share one active movie check', async () => {
  const { checks, mteam, service } = harness();
  mteam.releases = [{ imdbId: 'tt0133093', visible: true, banned: false, seeders: 1 }];

  const [first, second] = await Promise.all([
    service.request('owner-a', 603),
    service.request('owner-a', 603),
  ]);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual([first, second].sort(), [false, true]);
  assert.equal(checks.acquireCalls.length, 2);
  assert.equal(mteam.queries.length, 1);
});

test('IMDb checks count only exact, visible, unbanned releases with seeders', async () => {
  const { checks, mteam, service } = harness();
  mteam.releases = [
    { imdbId: 'tt0133093', visible: true, banned: false, seeders: 2 },
    { imdbId: 'tt0133093', visible: true, banned: false, seeders: 0 },
    { imdbId: 'tt0133093', visible: false, banned: false, seeders: 8 },
    { imdbId: 'tt9999999', visible: true, banned: false, seeders: 9 },
  ];

  assert.equal(await service.checkNow('owner-a', 603), true);

  assert.deepEqual(mteam.queries, [{ imdbId: 'tt0133093' }]);
  assert.equal(checks.completed[0]?.lastAttemptStatus, 'success');
  assert.equal(checks.completed[0] && 'availability' in checks.completed[0] ? checks.completed[0].availability : undefined, 'available');
  assert.equal(checks.completed[0] && 'matchedBy' in checks.completed[0] ? checks.completed[0].matchedBy : undefined, 'imdb');
  assert.equal(checks.completed[0] && 'expiresAt' in checks.completed[0] ? checks.completed[0].expiresAt.toISOString() : undefined, '2026-10-14T00:00:00.000Z');
});

test('a successful IMDb query with only dead or hidden releases is unavailable', async () => {
  const { checks, mteam, service } = harness();
  mteam.releases = [
    { imdbId: 'tt0133093', visible: true, banned: false, seeders: 0 },
    { imdbId: 'tt0133093', visible: false, banned: false, seeders: 5 },
  ];

  await service.checkNow('owner-a', 603);

  assert.equal(checks.completed[0]?.lastAttemptStatus, 'success');
  assert.equal(checks.completed[0] && 'availability' in checks.completed[0] ? checks.completed[0].availability : undefined, 'unavailable');
  assert.equal(checks.completed[0] && 'expiresAt' in checks.completed[0] ? checks.completed[0].expiresAt.toISOString() : undefined, '2026-10-13T06:00:00.000Z');
});

test('missing IMDb ID refreshes TMDB details then uses title only as an uncertain fallback', async () => {
  const { checks, mteam, service, writes } = harness({ title: 'Local title' });

  await service.checkNow('owner-a', 603);

  assert.equal(writes.length, 1);
  assert.deepEqual(mteam.queries, [{ title: 'The Matrix' }]);
  assert.equal(checks.completed[0]?.lastAttemptStatus, 'success');
  assert.equal(checks.completed[0] && 'availability' in checks.completed[0] ? checks.completed[0].availability : undefined, 'unmatchable');
  assert.equal(checks.completed[0] && 'matchedBy' in checks.completed[0], false);
  assert.equal(checks.completed[0] && 'expiresAt' in checks.completed[0], false);
  assert.equal(checks.completed[0] && 'identityFingerprint' in checks.completed[0]
    ? checks.completed[0].identityFingerprint
    : undefined, '["The Matrix",null]');
});

test('temporary request failures persist only the latest attempt outcome and error code', async () => {
  const { checks, mteam, service } = harness();
  mteam.error = new IntegrationValidationError('timeout', 'timed out');

  await service.checkNow('owner-a', 603);

  assert.deepEqual(checks.completed[0], {
    lastAttemptStatus: 'error',
    lastErrorCode: 'timeout',
  });
});

test('permission failures persist an error without inventing an availability result', async () => {
  const { checks, mteam, service } = harness();
  mteam.error = new IntegrationValidationError('permission', 'forbidden');

  await service.checkNow('owner-a', 603);

  assert.deepEqual(checks.completed[0], {
    lastAttemptStatus: 'error',
    lastErrorCode: 'permission',
  });
});

test('authentication failure disables later automatic checks until configuration changes', async () => {
  const { checks, mteam, service } = harness();
  mteam.error = new IntegrationValidationError('authentication', 'invalid API key');

  const first = await service.checkNowDetailed('owner-a', 603);
  const second = await service.checkNowDetailed('owner-a', 603);

  assert.deepEqual(first, { started: true, result: { lastAttemptStatus: 'error', lastErrorCode: 'authentication' } });
  assert.deepEqual(second, { started: true, result: { lastAttemptStatus: 'error', lastErrorCode: 'authentication' } });
  assert.equal(mteam.queries.length, 1);
  assert.equal(checks.completed.length, 1);
});

test('unexpected server failures are stored as a sanitized internal error', async () => {
  const { checks, mteam, service } = harness();
  mteam.error = new Error('database password must not be persisted');

  await service.checkNow('owner-a', 603);

  assert.deepEqual(checks.completed[0], {
    lastAttemptStatus: 'error',
    lastErrorCode: 'internal_error',
  });
});

test('an in-progress attempt prevents the duplicate check from calling M-Team', async () => {
  const { checks, mteam, service } = harness();
  checks.acquire = false;

  assert.equal(await service.checkNow('owner-a', 603), false);
  assert.equal(mteam.queries.length, 0);
});

test('active release predicate rejects hidden, banned, and dead torrents', () => {
  assert.equal(isActiveRelease({ visible: true, banned: false, seeders: 1 }), true);
  assert.equal(isActiveRelease({ visible: false, banned: false, seeders: 1 }), false);
  assert.equal(isActiveRelease({ visible: true, banned: true, seeders: 1 }), false);
  assert.equal(isActiveRelease({ visible: true, banned: false, seeders: 0 }), false);
});

test('live release queries return only active exact matches and reuse the short-lived cache', async () => {
  const { checks, mteam, service } = harness();
  mteam.releases = [
    {
      id: '1', title: 'The.Matrix.1999.2160p', imdbId: 'tt0133093', visible: true, banned: false,
      seeders: 8, leechers: 2, sizeBytes: 1024, resolution: '4K', tags: ['中字'],
    },
    { id: '2', title: 'Dead', imdbId: 'tt0133093', visible: true, banned: false, seeders: 0 },
    { id: '3', title: 'Wrong movie', imdbId: 'tt9999999', visible: true, banned: false, seeders: 20 },
  ];

  const [first, duplicate] = await Promise.all([
    service.listReleases('owner-a', 603),
    service.listReleases('owner-a', 603),
  ]);
  const cached = await service.listReleases('owner-a', 603);

  assert.equal(mteam.queries.length, 1);
  assert.equal(first.cached, false);
  assert.equal(duplicate.cached, false);
  assert.equal(cached.cached, true);
  assert.deepEqual(first.releases, [{
    id: '1', title: 'The.Matrix.1999.2160p', seeders: 8, leechers: 2,
    sizeBytes: 1024, resolution: '4K', tags: ['中字'],
  }]);
  const completion = checks.completed.at(-1);
  assert.equal(completion?.lastAttemptStatus, 'success');
  assert.equal(completion && 'availability' in completion ? completion.availability : undefined, 'available');
});

test('a failed live query records only an error result and does not return stale releases', async () => {
  const { checks, mteam, service } = harness();
  mteam.error = new IntegrationValidationError('timeout', 'timed out');

  await assert.rejects(() => service.listReleases('owner-a', 603), {
    statusCode: 504,
    code: 'MTEAM_TIMEOUT',
  });

  assert.deepEqual(checks.completed.at(-1), { lastAttemptStatus: 'error', lastErrorCode: 'timeout' });
});
