import type { Locale } from '@movie-hub/contract';
import type { MovieResourceCheckDispatcher } from '../movie-statuses/movie-status.service.js';
import type { MovieCatalogStore, MovieSearchProvider } from '../movies/movie.types.js';
import { IntegrationValidationError, integrationSecretContext } from './integration.service.js';
import type { IntegrationConfigStore } from './integration.types.js';
import type {
  MTeamRelease,
  MTeamResourceSearcher,
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
  resultTtlMs: number;
  retryDelayMs: number;
  leaseMs: number;
  minimumIntervalMs: number;
}

interface QueuedCheck {
  ownerId: string;
  tmdbId: number;
  force: boolean;
}

export class MovieResourceCheckService implements MovieResourceCheckDispatcher {
  private readonly queue = new Map<string, QueuedCheck>();
  private draining = false;
  private lastStartedAt = 0;

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
    const key = taskKey(ownerId, tmdbId, 'mteam');
    const queued = this.queue.get(key);
    this.queue.set(key, {
      ownerId,
      tmdbId,
      force: Boolean(options.force || queued?.force),
    });
    void this.drain();
  }

  async checkNow(ownerId: string, tmdbId: number, force = false): Promise<boolean> {
    const config = await this.configs.find(ownerId, 'mteam');
    if (!config) return false;
    const key: MovieResourceCheckKey = { ownerId, tmdbId, provider: 'mteam' };
    const attemptedAt = this.now();
    const acquired = await this.checks.tryAcquire(
      key,
      attemptedAt,
      new Date(attemptedAt.getTime() + this.options.leaseMs),
      new Date(attemptedAt.getTime() - this.options.retryDelayMs),
      force,
    );
    if (!acquired) return false;

    try {
      await this.respectMinimumInterval();
      let apiKey: string;
      try {
        apiKey = this.secrets.decrypt(config.encryptedApiKey, integrationSecretContext(ownerId, 'mteam'));
      } catch (error) {
        throw new IntegrationValidationError('invalid_response', 'Stored M-Team credentials could not be decrypted', { cause: error });
      }
      const result = await this.lookup(config.baseUrl, apiKey, tmdbId);
      await this.checks.complete(key, attemptedAt, result);
      this.logger.info(
        { ownerId, tmdbId, provider: 'mteam', availability: result.availability },
        'Movie resource check completed',
      );
    } catch (error) {
      const result = this.failureResult(error);
      await this.checks.complete(key, attemptedAt, result);
      this.logger.error(
        { err: error, ownerId, tmdbId, provider: 'mteam', errorCode: result.lastErrorCode },
        'Movie resource check failed',
      );
    }
    return true;
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
          await this.checkNow(entry[1].ownerId, entry[1].tmdbId, entry[1].force);
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
        lastAttemptStatus: 'success',
        availability: exact.some(isActiveRelease) ? 'available' : 'unavailable',
        matchedBy: 'imdb',
        checkedAt,
        expiresAt: new Date(checkedAt.getTime() + this.options.resultTtlMs),
      };
    }

    // A title query is only candidate discovery. Phase one cannot promote a
    // title-only candidate to a reliable match or an available resource.
    await this.mteam.searchMovies(baseUrl, apiKey, { title: identity.title });
    const checkedAt = this.now();
    return {
      lastAttemptStatus: 'success',
      availability: 'unmatchable',
      checkedAt,
      expiresAt: new Date(checkedAt.getTime() + this.options.resultTtlMs),
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
    const delay = Math.max(0, this.lastStartedAt + this.options.minimumIntervalMs - Date.now());
    if (delay > 0) await this.wait(delay);
    this.lastStartedAt = Date.now();
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

function taskKey(ownerId: string, tmdbId: number, provider: 'mteam'): string {
  return `${ownerId}:${tmdbId}:${provider}`;
}
