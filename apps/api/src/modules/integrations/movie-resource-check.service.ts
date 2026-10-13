import type { Locale, MovieRelease, MovieReleaseListResponse } from '@movie-hub/contract';
import { AppError } from '../../infrastructure/http/app-error.js';
import type { MovieResourceCheckDispatcher } from '../movie-statuses/movie-status.service.js';
import type { MovieCatalogStore, MovieSearchProvider } from '../movies/movie.types.js';
import { IntegrationValidationError, integrationSecretContext } from './integration.service.js';
import type { IntegrationConfigStore } from './integration.types.js';
import type {
  MTeamRelease,
  MTeamResourceSearcher,
  MovieResourceCheckErrorCode,
  MovieResourceCheckKey,
  MovieResourceCheckCompletion,
  MovieResourceCheckStore,
} from './movie-resource-check.types.js';
import type { SecretCrypto } from './secret-crypto.js';

interface CheckLogger {
  info(bindings: Record<string, unknown>, message: string): void;
  error(bindings: Record<string, unknown>, message: string): void;
}

export interface MovieResourceCheckOptions {
  availableTtlMs: number;
  unavailableTtlMs: number;
  retryDelayMs: number;
  leaseMs: number;
  minimumIntervalMs: number;
  releaseListTtlMs: number;
}

interface QueuedCheck {
  ownerId: string;
  tmdbId: number;
  attemptedAt: Date;
}

export type MovieResourceCheckExecution =
  | { started: false }
  | { started: true; result: MovieResourceCheckCompletion };

export class MovieResourceCheckService implements MovieResourceCheckDispatcher {
  private readonly queue = new Map<string, QueuedCheck>();
  private readonly releaseCache = new Map<string, { expiresAt: number; value: MovieReleaseListResponse }>();
  private readonly releaseRequests = new Map<string, Promise<MovieReleaseListResponse>>();
  private draining = false;
  private lastStartedAt = 0;
  private intervalGate: Promise<void> = Promise.resolve();
  private requestGate: Promise<void> = Promise.resolve();

  constructor(
    private readonly checks: MovieResourceCheckStore,
    private readonly configs: IntegrationConfigStore,
    private readonly secrets: SecretCrypto,
    private readonly mteam: MTeamResourceSearcher,
    private readonly movies: MovieCatalogStore,
    private readonly tmdb: MovieSearchProvider,
    private readonly locale: Locale,
    private readonly options: MovieResourceCheckOptions,
    private readonly logger: CheckLogger,
    private readonly now: () => Date = () => new Date(),
    private readonly wait: (milliseconds: number) => Promise<void> = (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
  ) {}

  schedule(ownerId: string, tmdbId: number, options: { force?: boolean } = {}): void {
    void this.enqueue(ownerId, tmdbId, Boolean(options.force)).catch((error) => {
      this.logger.error({ err: error, ownerId, tmdbId, provider: 'mteam' }, 'Could not enqueue movie resource check');
    });
  }

  async request(ownerId: string, tmdbId: number, force = true): Promise<boolean> {
    if (!await this.movies.hasMovie(tmdbId)) {
      throw new AppError(404, 'NOT_FOUND', 'Movie must be loaded before its resources can be checked.');
    }
    if (!await this.configs.find(ownerId, 'mteam')) {
      throw new AppError(409, 'MTEAM_NOT_CONFIGURED', 'Configure M-Team before checking movie resources.');
    }
    return this.enqueue(ownerId, tmdbId, force);
  }

  async listReleases(ownerId: string, tmdbId: number): Promise<MovieReleaseListResponse> {
    if (!await this.movies.hasMovie(tmdbId)) {
      throw new AppError(404, 'NOT_FOUND', 'Movie must be loaded before its releases can be queried.');
    }
    const config = await this.configs.find(ownerId, 'mteam');
    if (!config) {
      throw new AppError(409, 'MTEAM_NOT_CONFIGURED', 'Configure M-Team before querying releases.');
    }
    const wallTime = Date.now();
    for (const [key, value] of this.releaseCache) {
      if (value.expiresAt <= wallTime) this.releaseCache.delete(key);
    }
    const cacheKey = `${taskKey(ownerId, tmdbId, 'mteam')}:${config.verifiedAt?.getTime() ?? 0}`;
    const cached = this.releaseCache.get(cacheKey);
    if (cached) return { ...cached.value, cached: true };

    const pending = this.releaseRequests.get(cacheKey);
    if (pending) return pending;
    const request = this.fetchReleases(ownerId, tmdbId, config.baseUrl, config.encryptedApiKey)
      .then((value) => {
        this.releaseCache.set(cacheKey, { expiresAt: Date.now() + this.options.releaseListTtlMs, value });
        return value;
      })
      .finally(() => this.releaseRequests.delete(cacheKey));
    this.releaseRequests.set(cacheKey, request);
    return request;
  }

  private async fetchReleases(
    ownerId: string,
    tmdbId: number,
    baseUrl: string,
    encryptedApiKey: string,
  ): Promise<MovieReleaseListResponse> {
    const key: MovieResourceCheckKey = { ownerId, tmdbId, provider: 'mteam' };
    const attemptedAt = this.now();
    const startedAt = Date.now();
    try {
      let apiKey: string;
      try {
        apiKey = this.secrets.decrypt(encryptedApiKey, integrationSecretContext(ownerId, 'mteam'));
      } catch (error) {
        throw new IntegrationValidationError('invalid_response', 'Stored M-Team credentials could not be decrypted', { cause: error });
      }
      const lookup = await this.withMTeamRequestSlot(() => this.lookupReleases(baseUrl, apiKey, tmdbId));
      const completion = this.toSuccessfulCompletion(lookup);
      await this.checks.recordAttempt(key, attemptedAt, completion);
      this.logger.info(
        { ownerId, tmdbId, provider: 'mteam', availability: completion.availability, durationMs: Date.now() - startedAt },
        'Live M-Team release query completed',
      );
      return {
        provider: 'mteam',
        availability: completion.availability,
        queriedAt: completion.checkedAt.toISOString(),
        cached: false,
        releases: lookup.releases.flatMap(toDisplayRelease),
      };
    } catch (error) {
      const failure = this.failureResult(error);
      await this.checks.recordAttempt(key, attemptedAt, failure);
      if (failure.lastErrorCode === 'authentication') {
        await this.configs.recordFailure(ownerId, 'mteam', attemptedAt, 'authentication');
      }
      this.logger.error(
        { err: error, ownerId, tmdbId, provider: 'mteam', errorCode: failure.lastErrorCode, durationMs: Date.now() - startedAt },
        'Live M-Team release query failed',
      );
      throw publicMTeamAppError(failure.lastErrorCode);
    }
  }

  private async enqueue(ownerId: string, tmdbId: number, force: boolean): Promise<boolean> {
    const config = await this.configs.find(ownerId, 'mteam');
    if (!config || config.lastFailureType === 'authentication') return false;
    const key = taskKey(ownerId, tmdbId, 'mteam');
    if (this.queue.has(key)) return false;
    const attemptedAt = this.now();
    const identityFingerprint = await this.readIdentityFingerprint(tmdbId);
    const queuedLeaseExtensionMs = this.options.minimumIntervalMs * (this.queue.size + 1);
    const acquired = await this.checks.tryAcquire(
      { ownerId, tmdbId, provider: 'mteam' }, attemptedAt,
      new Date(attemptedAt.getTime() + this.options.leaseMs + queuedLeaseExtensionMs),
      new Date(attemptedAt.getTime() - this.options.retryDelayMs), identityFingerprint, config.verifiedAt, force,
    );
    if (!acquired) return false;
    this.queue.set(key, { ownerId, tmdbId, attemptedAt });
    void this.drain();
    return true;
  }

  async checkNow(ownerId: string, tmdbId: number, force = false): Promise<boolean> {
    return (await this.checkNowDetailed(ownerId, tmdbId, force)).started;
  }

  async checkNowDetailed(ownerId: string, tmdbId: number, force = false): Promise<MovieResourceCheckExecution> {
    const config = await this.configs.find(ownerId, 'mteam');
    if (!config || config.lastFailureType === 'authentication') {
      return { started: true, result: { lastAttemptStatus: 'error', lastErrorCode: 'authentication' } };
    }
    const key: MovieResourceCheckKey = { ownerId, tmdbId, provider: 'mteam' };
    const attemptedAt = this.now();
    const identityFingerprint = await this.readIdentityFingerprint(tmdbId);
    const acquired = await this.checks.tryAcquire(
      key,
      attemptedAt,
      new Date(attemptedAt.getTime() + this.options.leaseMs),
      new Date(attemptedAt.getTime() - this.options.retryDelayMs),
      identityFingerprint,
      config.verifiedAt,
      force,
    );
    if (!acquired) return { started: false };

    return { started: true, result: await this.executeAcquired(key, attemptedAt) };
  }

  private async executeAcquired(key: MovieResourceCheckKey, attemptedAt: Date): Promise<MovieResourceCheckCompletion> {
    const startedAt = Date.now();
    try {
      const config = await this.configs.find(key.ownerId, 'mteam');
      if (!config) throw new IntegrationValidationError('authentication', 'M-Team is not configured');
      let apiKey: string;
      try {
        apiKey = this.secrets.decrypt(config.encryptedApiKey, integrationSecretContext(key.ownerId, 'mteam'));
      } catch (error) {
        throw new IntegrationValidationError('invalid_response', 'Stored M-Team credentials could not be decrypted', { cause: error });
      }
      const result = await this.withMTeamRequestSlot(() => this.lookup(config.baseUrl, apiKey, key.tmdbId));
      await this.checks.complete(key, attemptedAt, result);
      this.logger.info(
        { ownerId: key.ownerId, tmdbId: key.tmdbId, provider: 'mteam', availability: result.availability, durationMs: Date.now() - startedAt },
        'Movie resource check completed',
      );
      return result;
    } catch (error) {
      const result = this.failureResult(error);
      await this.checks.complete(key, attemptedAt, result);
      if (result.lastErrorCode === 'authentication') {
        try {
          await this.configs.recordFailure(key.ownerId, 'mteam', attemptedAt, 'authentication');
        } catch (recordError) {
          this.logger.error(
            { err: recordError, ownerId: key.ownerId, provider: 'mteam' },
            'Could not disable automatic checks after authentication failure',
          );
        }
      }
      this.logger.error(
        { err: error, ownerId: key.ownerId, tmdbId: key.tmdbId, provider: 'mteam', errorCode: result.lastErrorCode, durationMs: Date.now() - startedAt },
        'Movie resource check failed',
      );
      return result;
    }
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.size > 0) {
        const entry = this.queue.entries().next().value as [string, QueuedCheck] | undefined;
        if (!entry) break;
        this.queue.delete(entry[0]);
        try {
          const key = { ownerId: entry[1].ownerId, tmdbId: entry[1].tmdbId, provider: 'mteam' as const };
          // The lease was acquired before the item entered this process-local queue.
          const record = await this.checks.readOne(key);
          if (record?.checking) {
            await this.executeAcquired(key, entry[1].attemptedAt);
          }
        } catch (error) {
          this.logger.error(
            { err: error, ownerId: entry[1].ownerId, tmdbId: entry[1].tmdbId, provider: 'mteam' },
            'Movie resource check worker failed',
          );
        }
      }
    } finally {
      this.draining = false;
      if (this.queue.size > 0) void this.drain();
    }
  }

  private async lookup(
    baseUrl: string,
    apiKey: string,
    tmdbId: number,
  ): Promise<Extract<MovieResourceCheckCompletion, { lastAttemptStatus: 'success' }>> {
    return this.toSuccessfulCompletion(await this.lookupReleases(baseUrl, apiKey, tmdbId));
  }

  private async lookupReleases(
    baseUrl: string,
    apiKey: string,
    tmdbId: number,
  ): Promise<{
    availability: 'available' | 'unavailable' | 'unmatchable';
    checkedAt: Date;
    releases: MTeamRelease[];
    identityFingerprint?: string;
  }> {
    let identity = await this.movies.readMovieIdentity?.(tmdbId, this.locale) ?? null;
    if (!identity?.imdbId) {
      const detail = await this.tmdb.fetchDetails(tmdbId, this.locale);
      await this.movies.writeMovieDetail(detail, this.now(), this.locale);
      identity = { title: detail.title, ...(detail.imdbId ? { imdbId: detail.imdbId } : {}) };
    }

    if (identity.imdbId) {
      const imdbId = normalizeImdbId(identity.imdbId);
      const releases = await this.mteam.searchMovies(baseUrl, apiKey, { imdbId });
      const exact = releases.filter((release) => release.imdbId === imdbId);
      const checkedAt = this.now();
      return {
        availability: exact.some(isActiveRelease) ? 'available' : 'unavailable',
        checkedAt,
        releases: exact.filter(isActiveRelease),
      };
    }

    // A title query is only candidate discovery. Phase one cannot promote a
    // title-only candidate to a reliable match or an available resource.
    await this.mteam.searchMovies(baseUrl, apiKey, { title: identity.title });
    const checkedAt = this.now();
    return {
      availability: 'unmatchable',
      checkedAt,
      releases: [],
      identityFingerprint: identityFingerprintFor(identity),
    };
  }

  private toSuccessfulCompletion(
    lookup: Awaited<ReturnType<MovieResourceCheckService['lookupReleases']>>,
  ): Extract<MovieResourceCheckCompletion, { lastAttemptStatus: 'success' }> {
    if (lookup.availability === 'unmatchable') {
      return {
        lastAttemptStatus: 'success', availability: 'unmatchable', checkedAt: lookup.checkedAt,
        identityFingerprint: lookup.identityFingerprint ?? '',
      };
    }
    return {
      lastAttemptStatus: 'success',
      availability: lookup.availability,
      matchedBy: 'imdb',
      checkedAt: lookup.checkedAt,
      expiresAt: new Date(lookup.checkedAt.getTime() + (
        lookup.availability === 'available' ? this.options.availableTtlMs : this.options.unavailableTtlMs
      )),
    };
  }

  private failureResult(
    error: unknown,
  ): Extract<MovieResourceCheckCompletion, { lastAttemptStatus: 'error' }> {
    const lastErrorCode = error instanceof IntegrationValidationError ? error.failureType : 'internal_error';
    return {
      lastAttemptStatus: 'error',
      lastErrorCode,
    };
  }

  private async respectMinimumInterval(): Promise<void> {
    const previous = this.intervalGate;
    let releaseGate: () => void = () => undefined;
    this.intervalGate = new Promise((resolve) => { releaseGate = resolve; });
    await previous;
    try {
      const delay = Math.max(0, this.lastStartedAt + this.options.minimumIntervalMs - Date.now());
      if (delay > 0) await this.wait(delay);
      this.lastStartedAt = Date.now();
    } finally {
      releaseGate();
    }
  }

  private async withMTeamRequestSlot<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.requestGate;
    let releaseGate: () => void = () => undefined;
    this.requestGate = new Promise((resolve) => { releaseGate = resolve; });
    await previous;
    try {
      await this.respectMinimumInterval();
      return await operation();
    } finally {
      releaseGate();
    }
  }

  private async readIdentityFingerprint(tmdbId: number): Promise<string | undefined> {
    const identity = await this.movies.readMovieIdentity?.(tmdbId, this.locale) ?? null;
    return identity ? identityFingerprintFor(identity) : undefined;
  }
}

export function isActiveRelease(release: MTeamRelease): boolean {
  return release.visible && !release.banned && release.seeders > 0;
}

function normalizeImdbId(value: string): string {
  const imdbId = value.match(/\b(tt\d{5,12})\b/i)?.[1]?.toLowerCase();
  if (!imdbId) throw new IntegrationValidationError('invalid_response', 'TMDB returned an invalid IMDb ID');
  return imdbId;
}

function identityFingerprintFor(identity: { title: string; imdbId?: string }): string {
  return JSON.stringify([
    identity.title.normalize('NFKC').trim(),
    identity.imdbId?.trim().toLowerCase() ?? null,
  ]);
}

function taskKey(ownerId: string, tmdbId: number, provider: 'mteam'): string {
  return `${ownerId}:${tmdbId}:${provider}`;
}

function toDisplayRelease(release: MTeamRelease): MovieRelease[] {
  if (!release.id || !release.title) return [];
  return [{
    id: release.id,
    title: release.title,
    seeders: release.seeders,
    ...(release.sizeBytes !== undefined ? { sizeBytes: release.sizeBytes } : {}),
    ...(release.leechers !== undefined ? { leechers: release.leechers } : {}),
    ...(release.publishedAt ? { publishedAt: release.publishedAt } : {}),
    ...(release.discount ? { discount: release.discount } : {}),
    ...(release.resolution ? { resolution: release.resolution } : {}),
    ...(release.medium ? { medium: release.medium } : {}),
    ...(release.videoCodec ? { videoCodec: release.videoCodec } : {}),
    ...(release.audioCodec ? { audioCodec: release.audioCodec } : {}),
    tags: release.tags ?? [],
  }];
}

function publicMTeamAppError(code: MovieResourceCheckErrorCode): AppError {
  const mapping = {
    authentication: [502, 'MTEAM_AUTH_FAILED'], permission: [502, 'MTEAM_AUTH_FAILED'],
    network: [503, 'MTEAM_UNREACHABLE'], timeout: [504, 'MTEAM_TIMEOUT'],
    rate_limited: [429, 'MTEAM_RATE_LIMITED'], invalid_response: [502, 'MTEAM_UNEXPECTED_RESPONSE'],
    remote_error: [502, 'MTEAM_UNEXPECTED_RESPONSE'], internal_error: [502, 'MTEAM_UNEXPECTED_RESPONSE'],
  } as const;
  const [status, publicCode] = mapping[code];
  return new AppError(status, publicCode, 'Could not query M-Team releases.');
}
