import type {
  Locale,
  MovieDetail,
  MoviePreference,
  MovieStatus,
  MovieSummary,
  SearchMoviesResponse,
  TrendingMoviesResponse,
} from '@movie-hub/contract';
import { AppError } from '../../infrastructure/http/app-error.js';
import type {
  MovieCatalogStore,
  MovieRecord,
  MovieSearchProvider,
  MovieStatusStore,
} from './movie.types.js';
import type { MediaTrendingReader } from '../media-trending/media-trending.types.js';
import { userExternalRequestContext } from '../external-usage/external-usage.domain.js';

export class MovieService {
  constructor(
    private readonly trendingReader: MediaTrendingReader<MovieRecord>,
    private readonly provider?: MovieSearchProvider,
    private readonly catalog?: MovieCatalogStore,
    private readonly statuses?: MovieStatusStore
  ) {}

  async trending(
    page: number,
    locale: Locale,
    ownerId: string | null,
    generation?: string
  ): Promise<TrendingMoviesResponse> {
    const result = await this.trendingReader.page(page, locale, ownerId, generation);
    const stateByMovie = await this.stateMap(
      ownerId,
      result.items.map(({ tmdbId }) => tmdbId)
    );
    return {
      items: result.items.map((movie) => {
        return toMovieSummary(
          movie,
          stateByMovie.get(movie.tmdbId)?.status,
          stateByMovie.get(movie.tmdbId)?.preference
        );
      }),
      page: result.page,
      hasMore: result.hasMore,
      source: 'cache',
      resultCompleteness: 'complete',
      fetchedAt: result.fetchedAt,
      generation: result.generation,
      locale,
    };
  }

  async search(query: string, page: number, locale: Locale, ownerId: string | null): Promise<SearchMoviesResponse> {
    if (!this.provider || !this.catalog)
      throw new AppError(503, 'SERVICE_UNAVAILABLE', 'Movie search is not available.');
    const normalized = query.trim();
    if (!normalized) throw new AppError(400, 'BAD_REQUEST', 'Search query is required.');
    const cached = await this.catalog.readSearch(normalized, page, locale);
    const summaryTtlMs = 24 * 60 * 60 * 1_000;
    const cacheMatchesLocale
      = cached !== null
        && cached.movies.every((movie) => {
          return movie.localizationLocale === locale;
        });
    const localeCache = cacheMatchesLocale ? cached : null;
    const expectedMovieCount = localeCache?.expectedMovieCount ?? localeCache?.movies.length;
    const cachedIsFresh = localeCache !== null && localeCache.movies.length === expectedMovieCount;
    const allSummariesFresh
      = cachedIsFresh
        && localeCache.movies.every((movie) => {
          return (
            movie.localizationLocale === locale
            && movie.summarySyncedAt
            && Date.now() - movie.summarySyncedAt.getTime() < summaryTtlMs
          );
        });
    let result = localeCache;
    let source: SearchMoviesResponse['source'] = 'cache';
    let resultCompleteness: SearchMoviesResponse['resultCompleteness'] = 'complete';
    if (!allSummariesFresh) {
      try {
        const fetched = await this.provider.search(
          normalized,
          page,
          locale,
          userExternalRequestContext(ownerId, 'api_request')
        );
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
    const stateByMovie = await this.stateMap(
      ownerId,
      result.movies.map(({ tmdbId }) => tmdbId)
    );
    return {
      items: result.movies.map((movie) => {
        return toMovieSummary(
          movie,
          stateByMovie.get(movie.tmdbId)?.status,
          stateByMovie.get(movie.tmdbId)?.preference
        );
      }),
      page: result.page,
      hasMore: result.page < result.totalPages,
      source,
      resultCompleteness,
      locale,
    };
  }

  async detail(tmdbId: number, locale: Locale, ownerId: string | null): Promise<MovieDetail> {
    if (!this.provider || !this.catalog)
      throw new AppError(503, 'SERVICE_UNAVAILABLE', 'Movie details are not available.');
    const cached = await this.catalog.readMovieDetail(tmdbId, locale);
    const localeCache = cached?.localizationLocale === locale ? cached : null;
    const fresh
      = localeCache?.detailSyncedAt
        && localeCache.trailerSyncedAt
        && Date.now() - Math.min(localeCache.detailSyncedAt.getTime(), localeCache.trailerSyncedAt.getTime())
        < 7 * 24 * 60 * 60 * 1_000;
    let movie = localeCache;
    let stale = false;
    if (!fresh) {
      try {
        movie = await this.provider.fetchDetails(tmdbId, locale, userExternalRequestContext(ownerId, 'api_request'));
        const syncedAt = new Date();
        await this.catalog.writeMovieDetail(movie, syncedAt, locale);
        movie.detailSyncedAt = syncedAt;
        movie.trailerSyncedAt = syncedAt;
        movie.localizationLocale = locale;
      } catch (error) {
        if (!localeCache) throw error;
        movie = localeCache;
        stale = true;
      }
    }
    if (!movie?.detailSyncedAt) throw new AppError(503, 'SERVICE_UNAVAILABLE', 'Movie details are not available.');
    const state = (await this.stateMap(ownerId, [tmdbId])).get(tmdbId);
    return toMovieDetail(movie, state?.status ?? 'unwatched', state?.preference ?? 'neutral', stale, locale);
  }

  private async stateMap(ownerId: string | null | undefined, tmdbIds: number[]) {
    if (!ownerId || !this.statuses) return new Map();
    const rows = await this.statuses.readForMovies(ownerId, tmdbIds);
    return new Map(rows.map(({ tmdbId, status, preference }) => [tmdbId, { status, preference }]));
  }

  async loadMore(
    currentPage: number,
    generation: string,
    locale: Locale,
    ownerId: string | null
  ): Promise<TrendingMoviesResponse> {
    return this.trending(currentPage + 1, locale, ownerId, generation);
  }
}

function imageUrl(path: string, size: 'w185' | 'w500' | 'w1280'): string {
  return `https://image.tmdb.org/t/p/${size}${path}`;
}

function toMovieDetail(
  movie: import('./movie.types.js').MovieDetailRecord,
  userStatus: MovieStatus,
  userPreference: MoviePreference,
  stale: boolean,
  locale: Locale
): MovieDetail {
  return {
    ...toMovieSummary(movie, userStatus, userPreference),
    ...(movie.imdbId ? { imdbId: movie.imdbId } : {}),
    ...(movie.tagline ? { tagline: movie.tagline } : {}),
    ...(movie.runtimeMinutes !== undefined ? { runtimeMinutes: movie.runtimeMinutes } : {}),
    ...(movie.backdropPath ? { backdropUrl: imageUrl(movie.backdropPath, 'w1280') } : {}),
    ...(movie.voteCount !== undefined ? { voteCount: movie.voteCount } : {}),
    ...(movie.trailer
      ? {
          trailer: {
            tmdbVideoId: movie.trailer.tmdbVideoId,
            provider: movie.trailer.provider,
            providerVideoId: movie.trailer.providerVideoId,
            name: movie.trailer.name,
            ...(movie.trailer.language ? { language: movie.trailer.language } : {}),
            ...(movie.trailer.region ? { region: movie.trailer.region } : {}),
            official: movie.trailer.official,
            ...(movie.trailer.publishedAt ? { publishedAt: movie.trailer.publishedAt.toISOString() } : {}),
          },
        }
      : {}),
    genres: movie.genres,
    cast: movie.cast.map(({ person, character }) => {
      return {
        tmdbId: person.tmdbId,
        name: person.name,
        ...(person.originalName ? { originalName: person.originalName } : {}), ...(character ? { character } : {}),
        ...(person.profilePath ? { profileUrl: imageUrl(person.profilePath, 'w185') } : {}),
      };
    }),
    directors: movie.directors.map(({ person }) => {
      return {
        tmdbId: person.tmdbId,
        name: person.name,
        ...(person.originalName ? { originalName: person.originalName } : {}), ...(person.profilePath ? { profileUrl: imageUrl(person.profilePath, 'w185') } : {}),
      };
    }),
    detailSyncedAt: movie.detailSyncedAt!.toISOString(),
    stale,
    locale,
  };
}

export function toMovieSummary(
  movie: MovieRecord,
  userStatus: MovieStatus = 'unwatched',
  userPreference: MoviePreference = 'neutral'
): MovieSummary {
  return {
    tmdbId: movie.tmdbId,
    title: movie.title,
    ...(movie.originalTitle ? { originalTitle: movie.originalTitle } : {}),
    ...(movie.overview ? { overview: movie.overview } : {}),
    ...(movie.releaseDate ? { releaseDate: movie.releaseDate } : {}),
    ...(movie.posterPath ? { posterUrl: imageUrl(movie.posterPath, 'w500') } : {}),
    ...(movie.voteAverage !== undefined ? { voteAverage: movie.voteAverage } : {}),
    userStatus,
    userPreference,
  };
}
