import type { Locale, MovieDetail, MovieStatus, MovieSummary, SearchMoviesResponse, TrendingMoviesResponse } from '@movie-hub/contract';
import { AppError } from '../../infrastructure/http/app-error.js';
import type { MovieCatalogStore, MovieRecord, MovieSearchProvider, MovieStatusStore, TrendingStore } from './movie.types.js';
import type { TrendingSyncService } from './trending-sync.service.js';

export class MovieService {
  constructor(
    private readonly store: TrendingStore,
    private readonly sync: TrendingSyncService,
    private readonly provider?: MovieSearchProvider,
    private readonly catalog?: MovieCatalogStore,
    private readonly statuses?: MovieStatusStore,
  ) {}

  async trending(page: number, locale: Locale, ownerId: string | null): Promise<TrendingMoviesResponse> {
    let result = await this.store.readPage(page, locale);
    if (!result && page === 1) {
      const sync = await this.sync.syncPage(page, 'request', locale);
      if (sync.status === 'skipped') {
        result = await this.store.readPage(page, locale);
        if (!result) throw new AppError(409, 'TRENDING_SYNC_IN_PROGRESS', 'This page is already being refreshed. Please retry shortly.');
      } else {
        result = await this.store.readPage(page, locale);
      }
    }
    if (!result) throw new AppError(503, 'TRENDING_NOT_SYNCED', 'Trending movies are not available yet.');
    const statusByMovie = await this.statusMap(ownerId, result.movies.map(({ tmdbId }) => tmdbId));
    return {
      items: result.movies.map((movie) => toMovieSummary(movie, statusByMovie.get(movie.tmdbId))),
      page: result.page,
      hasMore: result.page < result.totalPages,
      source: 'cache',
      resultCompleteness: 'complete',
      fetchedAt: result.fetchedAt.toISOString(),
      locale,
    };
  }

  async search(query: string, page: number, locale: Locale, ownerId: string | null): Promise<SearchMoviesResponse> {
    if (!this.provider || !this.catalog) throw new AppError(503, 'SERVICE_UNAVAILABLE', 'Movie search is not available.');
    const normalized = query.trim();
    if (!normalized) throw new AppError(400, 'BAD_REQUEST', 'Search query is required.');
    const cached = await this.catalog.readSearch(normalized, page, locale);
    const summaryTtlMs = 24 * 60 * 60 * 1_000;
    const cacheMatchesLocale = cached !== null && cached.movies.every((movie) => movie.localizationLocale === locale);
    const localeCache = cacheMatchesLocale ? cached : null;
    const expectedMovieCount = localeCache?.expectedMovieCount ?? localeCache?.movies.length;
    const cachedIsFresh = localeCache !== null && localeCache.movies.length === expectedMovieCount;
    const allSummariesFresh = cachedIsFresh && localeCache.movies.every((movie) =>
      movie.localizationLocale === locale && movie.summarySyncedAt
      && Date.now() - movie.summarySyncedAt.getTime() < summaryTtlMs,
    );
    let result = localeCache;
    let source: SearchMoviesResponse['source'] = 'cache';
    let resultCompleteness: SearchMoviesResponse['resultCompleteness'] = 'complete';
    if (!allSummariesFresh) {
      try {
        const fetched = await this.provider.search(normalized, page, locale);
        result = { ...fetched, fetchedAt: new Date() };
        await this.catalog.publishSearch(normalized, result, locale);
        source = 'tmdb';
      } catch (error) {
        if (!localeCache) throw error;
        result = localeCache;
        source = 'local-fallback';
        resultCompleteness = localeCache.movies.length === expectedMovieCount ? 'complete' : 'partial';
      }
    }
    if (!result) throw new AppError(503, 'SERVICE_UNAVAILABLE', 'Movie search is not available.');
    const statusByMovie = await this.statusMap(ownerId, result.movies.map(({ tmdbId }) => tmdbId));
    return {
      items: result.movies.map((movie) => toMovieSummary(movie, statusByMovie.get(movie.tmdbId))),
      page: result.page,
      hasMore: result.page < result.totalPages,
      source,
      resultCompleteness,
      locale,
    };
  }

  async detail(tmdbId: number, locale: Locale, ownerId: string | null): Promise<MovieDetail> {
    if (!this.provider || !this.catalog) throw new AppError(503, 'SERVICE_UNAVAILABLE', 'Movie details are not available.');
    const cached = await this.catalog.readMovieDetail(tmdbId, locale);
    const localeCache = cached?.localizationLocale === locale ? cached : null;
    const fresh = localeCache?.detailSyncedAt
      && Date.now() - localeCache.detailSyncedAt.getTime() < 7 * 24 * 60 * 60 * 1_000;
    let movie = localeCache;
    let stale = false;
    if (!fresh) {
      try {
        movie = await this.provider.fetchDetails(tmdbId, locale);
        const syncedAt = new Date();
        await this.catalog.writeMovieDetail(movie, syncedAt, locale);
        movie.detailSyncedAt = syncedAt;
        movie.localizationLocale = locale;
      } catch (error) {
        if (!localeCache) throw error;
        movie = localeCache;
        stale = true;
      }
    }
    if (!movie?.detailSyncedAt) throw new AppError(503, 'SERVICE_UNAVAILABLE', 'Movie details are not available.');
    const status = (await this.statusMap(ownerId, [tmdbId])).get(tmdbId) ?? 'unwatched';
    return toMovieDetail(movie, status, stale, locale);
  }

  private async statusMap(ownerId: string | null | undefined, tmdbIds: number[]): Promise<Map<number, MovieStatus>> {
    if (!ownerId || !this.statuses) return new Map();
    const rows = await this.statuses.readForMovies(ownerId, tmdbIds);
    return new Map(rows.map(({ tmdbId, status }) => [tmdbId, status]));
  }

  async loadMore(currentPage: number, locale: Locale, ownerId: string | null): Promise<TrendingMoviesResponse> {
    const current = await this.store.readPage(currentPage, locale);
    if (!current) throw new AppError(400, 'BAD_REQUEST', 'The current trending page is not available.');
    if (currentPage >= current.totalPages) throw new AppError(400, 'BAD_REQUEST', 'There are no more trending pages.');
    const nextPage = currentPage + 1;
    const existing = await this.store.readPage(nextPage, locale);
    if (!existing) {
      const result = await this.sync.syncPage(nextPage, 'load-more', locale);
      if (result.status === 'skipped') throw new AppError(409, 'TRENDING_SYNC_IN_PROGRESS', 'This page is already being refreshed. Please retry shortly.');
    }
    return this.trending(nextPage, locale, ownerId);
  }
}

function imageUrl(path: string, size: 'w185' | 'w500' | 'w1280'): string {
  return `https://image.tmdb.org/t/p/${size}${path}`;
}

function toMovieDetail(movie: import('./movie.types.js').MovieDetailRecord, userStatus: MovieStatus, stale: boolean, locale: Locale): MovieDetail {
  return {
    ...toMovieSummary(movie, userStatus),
    ...(movie.imdbId ? { imdbId: movie.imdbId } : {}),
    ...(movie.tagline ? { tagline: movie.tagline } : {}),
    ...(movie.runtimeMinutes !== undefined ? { runtimeMinutes: movie.runtimeMinutes } : {}),
    ...(movie.backdropPath ? { backdropUrl: imageUrl(movie.backdropPath, 'w1280') } : {}),
    ...(movie.voteCount !== undefined ? { voteCount: movie.voteCount } : {}),
    genres: movie.genres,
    cast: movie.cast.map(({ person, character }) => ({ tmdbId: person.tmdbId, name: person.name,
      ...(character ? { character } : {}),
      ...(person.profilePath ? { profileUrl: imageUrl(person.profilePath, 'w185') } : {}),
    })),
    directors: movie.directors.map(({ person }) => ({ tmdbId: person.tmdbId, name: person.name,
      ...(person.profilePath ? { profileUrl: imageUrl(person.profilePath, 'w185') } : {}),
    })),
    detailSyncedAt: movie.detailSyncedAt!.toISOString(), stale, locale,
  };
}

export function toMovieSummary(movie: MovieRecord, userStatus: MovieStatus = 'unwatched'): MovieSummary {
  return {
    tmdbId: movie.tmdbId,
    title: movie.title,
    ...(movie.originalTitle ? { originalTitle: movie.originalTitle } : {}),
    ...(movie.overview ? { overview: movie.overview } : {}),
    ...(movie.releaseDate ? { releaseDate: movie.releaseDate } : {}),
    ...(movie.posterPath ? { posterUrl: imageUrl(movie.posterPath, 'w500') } : {}),
    ...(movie.voteAverage !== undefined ? { voteAverage: movie.voteAverage } : {}),
    userStatus,
  };
}
