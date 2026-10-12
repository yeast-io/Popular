import type { Locale, MyMoviesResponse, TrackedMovieStatus } from '@movie-hub/contract';
import { AppError } from '../../infrastructure/http/app-error.js';
import type { MovieCatalogStore, MovieStatusStore } from '../movies/movie.types.js';
import { toMovieSummary } from '../movies/movie.service.js';

export class MovieStatusService {
  constructor(
    private readonly statuses: MovieStatusStore,
    private readonly movies: MovieCatalogStore,
    private readonly defaultLocale: Locale,
  ) {}

  async set(ownerId: string, tmdbId: number, status: TrackedMovieStatus) {
    if (!await this.movies.hasMovie(tmdbId)) throw new AppError(404, 'NOT_FOUND', 'Movie must be loaded from search or trending before it can be saved.');
    await this.statuses.set(ownerId, tmdbId, status);
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
    const movies = await this.movies.readMovies(result.items.map(({ tmdbId }) => tmdbId), locale);
    const statusById = new Map(result.items.map((item) => [item.tmdbId, item.status]));
    return {
      items: movies.flatMap((movie) => {
        const movieStatus = statusById.get(movie.tmdbId);
        return movieStatus ? [{ ...toMovieSummary(movie, movieStatus), userStatus: movieStatus }] : [];
      }),
      pagination: { page, pageSize, total: result.total, hasMore: page * pageSize < result.total },
      locale,
    };
  }
}
