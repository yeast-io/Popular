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
  acquireCalls: Array<{ key: MovieResourceCheckKey; force: boolean }> = [];
  completed: MovieResourceCheckCompletion[] = [];

  async readForMovies() { return []; }

  async tryAcquire(key: MovieResourceCheckKey, _attemptedAt: Date, _staleAttemptBefore: Date, _failedAttemptBefore: Date, force: boolean) {
    this.acquireCalls.push({ key, force });
    return this.acquire;
  }

  async complete(_key: MovieResourceCheckKey, _attemptedAt: Date, result: MovieResourceCheckCompletion) {
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
  const configs = {
    find: async () => ({ ownerId: 'owner-a', provider: 'mteam' as const, baseUrl: 'https://api.m-team.cc', encryptedApiKey }),
  } as unknown as IntegrationConfigStore;
  const writes: MovieDetailRecord[] = [];
  const movies = {
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
    { resultTtlMs: 86_400_000, retryDelayMs: 300_000, leaseMs: 120_000, minimumIntervalMs: 0 },
    { info: () => undefined, error: () => undefined },
    () => now,
  );
  return { checks, detail, mteam, service, writes };
}

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
});

test('missing IMDb ID refreshes TMDB details then uses title only as an uncertain fallback', async () => {
  const { checks, mteam, service, writes } = harness({ title: 'Local title' });

  await service.checkNow('owner-a', 603);

  assert.equal(writes.length, 1);
  assert.deepEqual(mteam.queries, [{ title: 'The Matrix' }]);
  assert.equal(checks.completed[0]?.lastAttemptStatus, 'success');
  assert.equal(checks.completed[0] && 'availability' in checks.completed[0] ? checks.completed[0].availability : undefined, 'unmatchable');
  assert.equal(checks.completed[0] && 'matchedBy' in checks.completed[0], false);
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
