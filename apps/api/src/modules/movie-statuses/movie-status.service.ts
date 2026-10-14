import type { Locale, MovieReleaseListResponse, MovieResourceCheckResponse, MyMoviesFilter, MyMoviesResponse, TrackedMoviePreference, TrackedMovieStatus } from '@movie-hub/contract';
import { AppError } from '../../infrastructure/http/app-error.js';
import type { MovieCatalogStore, MovieStatusStore } from '../movies/movie.types.js';
import { toMovieSummary } from '../movies/movie.service.js';
import type { MovieResourceCheckStore } from '../integrations/movie-resource-check.types.js';

export interface MovieResourceCheckDispatcher {
  schedule(ownerId: string, tmdbId: number, options?: { force?: boolean }): void;
  request?(ownerId: string, tmdbId: number, force?: boolean): Promise<boolean>;
  listReleases?(ownerId: string, tmdbId: number): Promise<MovieReleaseListResponse>;
}

export class MovieStatusService {
  constructor(
    private readonly statuses: MovieStatusStore,
    private readonly movies: MovieCatalogStore,
    private readonly defaultLocale: Locale,
    private readonly resourceChecks?: MovieResourceCheckDispatcher,
    private readonly resourceCheckStore?: Pick<MovieResourceCheckStore, 'readForMovies' | 'readOne'>,
  ) {}

  async set(ownerId: string, tmdbId: number, status: TrackedMovieStatus) {
    if (!await this.movies.hasMovie(tmdbId)) throw new AppError(404, 'NOT_FOUND', 'Movie must be loaded from search or trending before it can be saved.');
    const previousStatus = await this.statuses.setStatus(ownerId, tmdbId, status);
    if (status === 'interested' && previousStatus !== 'interested') {
      this.resourceChecks?.schedule(ownerId, tmdbId, { force: true });
    }
    return { tmdbId, status };
  }

  async clear(ownerId: string, tmdbId: number) {
    await this.statuses.clearStatus(ownerId, tmdbId);
    return { tmdbId, status: 'unwatched' as const };
  }

  async setPreference(ownerId: string, tmdbId: number, preference: TrackedMoviePreference) {
    if (!await this.movies.hasMovie(tmdbId)) throw new AppError(404, 'NOT_FOUND', 'Movie must be loaded from search or trending before it can be saved.');
    await this.statuses.setPreference(ownerId, tmdbId, preference);
    return { tmdbId, preference };
  }

  async clearPreference(ownerId: string, tmdbId: number) {
    await this.statuses.clearPreference(ownerId, tmdbId);
    return { tmdbId, preference: 'neutral' as const };
  }

  async resourceCheck(ownerId: string, tmdbId: number): Promise<MovieResourceCheckResponse> {
    if (!this.resourceCheckStore) return emptyResourceCheck();
    return toResourceCheckResponse(await this.resourceCheckStore.readOne({ ownerId, tmdbId, provider: 'mteam' }));
  }

  async recheckResource(ownerId: string, tmdbId: number): Promise<MovieResourceCheckResponse> {
    if (!this.resourceChecks?.request || !this.resourceCheckStore) {
      throw new AppError(503, 'SERVICE_UNAVAILABLE', 'Movie resource checks are unavailable.');
    }
    await this.resourceChecks.request(ownerId, tmdbId, true);
    return this.resourceCheck(ownerId, tmdbId);
  }

  async releases(ownerId: string, tmdbId: number): Promise<MovieReleaseListResponse> {
    if (!this.resourceChecks?.listReleases) {
      throw new AppError(503, 'SERVICE_UNAVAILABLE', 'Movie release queries are unavailable.');
    }
    return this.resourceChecks.listReleases(ownerId, tmdbId);
  }

  async list(
    ownerId: string,
    status: MyMoviesFilter | undefined,
    page: number,
    pageSize: number,
    locale: Locale = this.defaultLocale,
  ): Promise<MyMoviesResponse> {
    const result = await this.statuses.list(ownerId, status, page, pageSize);
    for (const item of result.items) {
      if (item.status === 'interested') this.resourceChecks?.schedule(ownerId, item.tmdbId);
    }
    const [movies, resourceChecks] = await Promise.all([
      this.movies.readMovies(result.items.map(({ tmdbId }) => tmdbId), locale),
      this.resourceCheckStore?.readForMovies(ownerId, result.items.map(({ tmdbId }) => tmdbId)) ?? [],
    ]);
    const stateById = new Map(result.items.map((item) => [item.tmdbId, item]));
    const resourceCheckById = new Map(resourceChecks.map((check) => [check.tmdbId, check]));
    return {
      items: movies.flatMap((movie) => {
        const state = stateById.get(movie.tmdbId);
        const storedResourceCheck = resourceCheckById.get(movie.tmdbId);
        const resourceCheck = storedResourceCheck
          ? toResourceCheckResponse(storedResourceCheck)
          : state?.status === 'interested' ? emptyResourceCheck() : undefined;
        return state ? [{
          ...toMovieSummary(movie, state.status, state.preference),
          ...(resourceCheck ? { resourceCheck } : {}),
        }] : [];
      }),
      pagination: { page, pageSize, total: result.total, hasMore: page * pageSize < result.total },
      locale,
    };
  }
}

function emptyResourceCheck(): MovieResourceCheckResponse {
  return { provider: 'mteam', checking: false, availability: 'unchecked' };
}

function toResourceCheckResponse(
  resourceCheck: Awaited<ReturnType<MovieResourceCheckStore['readOne']>>,
): MovieResourceCheckResponse {
  if (!resourceCheck) return emptyResourceCheck();
  return {
    provider: resourceCheck.provider,
    checking: resourceCheck.checking,
    availability: resourceCheck.availability,
    ...(resourceCheck.checkedAt ? { checkedAt: resourceCheck.checkedAt.toISOString() } : {}),
    ...(resourceCheck.expiresAt ? { expiresAt: resourceCheck.expiresAt.toISOString() } : {}),
    ...(resourceCheck.lastAttemptAt ? { lastAttemptAt: resourceCheck.lastAttemptAt.toISOString() } : {}),
    ...(resourceCheck.lastAttemptStatus ? { lastAttemptStatus: resourceCheck.lastAttemptStatus } : {}),
    ...(resourceCheck.lastErrorCode ? { lastErrorCode: publicMTeamErrorCode(resourceCheck.lastErrorCode) } : {}),
  };
}

function publicMTeamErrorCode(code: string) {
  const codes = {
    authentication: 'MTEAM_AUTH_FAILED', permission: 'MTEAM_AUTH_FAILED',
    network: 'MTEAM_UNREACHABLE', timeout: 'MTEAM_TIMEOUT', rate_limited: 'MTEAM_RATE_LIMITED',
    invalid_response: 'MTEAM_UNEXPECTED_RESPONSE', remote_error: 'MTEAM_UNEXPECTED_RESPONSE',
    internal_error: 'MTEAM_UNEXPECTED_RESPONSE',
  } as const;
  return codes[code as keyof typeof codes] ?? 'MTEAM_UNEXPECTED_RESPONSE';
}
