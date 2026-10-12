import type { Locale, MyMoviesResponse, TrackedMovieStatus } from '@movie-hub/contract';
import { AppError } from '../../infrastructure/http/app-error.js';
import type { MovieCatalogStore, MovieStatusStore } from '../movies/movie.types.js';
import { toMovieSummary } from '../movies/movie.service.js';
import type { MovieResourceCheckStore } from '../integrations/movie-resource-check.types.js';

export interface MovieResourceCheckDispatcher {
  schedule(ownerId: string, tmdbId: number, options?: { force?: boolean }): void;
}

export class MovieStatusService {
  constructor(
    private readonly statuses: MovieStatusStore,
    private readonly movies: MovieCatalogStore,
    private readonly defaultLocale: Locale,
    private readonly resourceChecks?: MovieResourceCheckDispatcher,
    private readonly resourceCheckStore?: Pick<MovieResourceCheckStore, 'readForMovies'>,
  ) {}

  async set(ownerId: string, tmdbId: number, status: TrackedMovieStatus) {
    if (!await this.movies.hasMovie(tmdbId)) throw new AppError(404, 'NOT_FOUND', 'Movie must be loaded from search or trending before it can be saved.');
    const previousStatus = await this.statuses.set(ownerId, tmdbId, status);
    if (status === 'interested' && previousStatus !== 'interested') {
      this.resourceChecks?.schedule(ownerId, tmdbId, { force: true });
    }
    return { tmdbId, status };
  }

  async clear(ownerId: string, tmdbId: number) {
    await this.statuses.delete(ownerId, tmdbId);
    return { tmdbId, status: 'unwatched' as const };
  }

  async list(
    ownerId: string,
    status: TrackedMovieStatus | undefined,
    page: number,
    pageSize: number,
    locale: Locale = this.defaultLocale,
  ): Promise<MyMoviesResponse> {
    const result = await this.statuses.list(ownerId, status, page, pageSize);
    const interestedIds = result.items
      .filter((item) => item.status === 'interested')
      .map((item) => item.tmdbId);
    for (const item of result.items) {
      if (item.status === 'interested') this.resourceChecks?.schedule(ownerId, item.tmdbId);
    }
    const [movies, resourceChecks] = await Promise.all([
      this.movies.readMovies(result.items.map(({ tmdbId }) => tmdbId), locale),
      this.resourceCheckStore?.readForMovies(ownerId, interestedIds) ?? [],
    ]);
    const statusById = new Map(result.items.map((item) => [item.tmdbId, item.status]));
    const resourceCheckById = new Map(resourceChecks.map((check) => [check.tmdbId, check]));
    return {
      items: movies.flatMap((movie) => {
        const movieStatus = statusById.get(movie.tmdbId);
        const resourceCheck = movieStatus === 'interested' ? resourceCheckById.get(movie.tmdbId) : undefined;
        return movieStatus ? [{
          ...toMovieSummary(movie, movieStatus),
          userStatus: movieStatus,
          ...(resourceCheck ? {
            resourceCheck: {
              provider: resourceCheck.provider,
              availability: resourceCheck.availability,
              ...(resourceCheck.checkedAt ? { checkedAt: resourceCheck.checkedAt.toISOString() } : {}),
              ...(resourceCheck.expiresAt ? { expiresAt: resourceCheck.expiresAt.toISOString() } : {}),
              ...(resourceCheck.lastAttemptAt ? { lastAttemptAt: resourceCheck.lastAttemptAt.toISOString() } : {}),
              ...(resourceCheck.lastAttemptStatus ? { lastAttemptStatus: resourceCheck.lastAttemptStatus } : {}),
              ...(resourceCheck.lastErrorCode ? { lastErrorCode: resourceCheck.lastErrorCode } : {}),
            },
          } : {}),
        }] : [];
      }),
      pagination: { page, pageSize, total: result.total, hasMore: page * pageSize < result.total },
      locale,
    };
  }
}
