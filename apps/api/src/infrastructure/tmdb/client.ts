import type { Locale } from '@movie-hub/contract';
import { randomUUID } from 'node:crypto';
import type { CreditRecord, MovieDetailRecord, MovieRecord, TrendingProvider } from '../../modules/movies/movie.types.js';
import type {
  ExternalRequestContext, ExternalRequestErrorCode, ExternalRequestRecorder,
} from '../../modules/external-usage/external-usage.types.js';

interface TmdbMovie {
  id: number;
  title?: string;
  original_title?: string;
  original_language?: string;
  overview?: string;
  release_date?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  genre_ids?: number[];
  vote_average?: number;
  vote_count?: number;
}

interface TmdbTrendingResponse {
  page: number;
  results: TmdbMovie[];
  total_pages: number;
  total_results: number;
}

interface TmdbDetail extends TmdbMovie {
  imdb_id?: string | null;
  tagline?: string;
  runtime?: number | null;
  genres?: Array<{ id: number; name: string }>;
  credits?: {
    cast?: Array<{ id: number; credit_id: string; name?: string; original_name?: string; character?: string; profile_path?: string | null; order?: number }>;
    crew?: Array<{ id: number; credit_id: string; name?: string; original_name?: string; job?: string; profile_path?: string | null }>;
  };
  translations?: {
    translations?: Array<{
      iso_639_1?: string;
      iso_3166_1?: string;
      data?: { title?: string; overview?: string; tagline?: string };
    }>;
  };
  videos?: { results?: TmdbVideo[] };
}

interface TmdbVideo {
  id?: string;
  iso_639_1?: string;
  iso_3166_1?: string;
  key?: string;
  name?: string;
  official?: boolean;
  published_at?: string;
  site?: string;
  type?: string;
}

export class TmdbClient implements TrendingProvider {
  constructor(
    private readonly credential: string,
    private readonly timeoutMs: number,
    private readonly baseUrl = 'https://api.themoviedb.org/3',
    private readonly fetcher: typeof fetch = globalThis.fetch,
    private readonly usage?: ExternalRequestRecorder
  ) {}

  async fetchPage(page: number, locale: Locale, context?: ExternalRequestContext) {
    const url = new URL(`${this.baseUrl}/trending/movie/week`);
    url.searchParams.set('language', locale);
    url.searchParams.set('page', String(page));
    const response = await this.request(url, 'movie.trending', context);
    const payload = await response.json() as TmdbTrendingResponse;
    if (!isTrendingResponse(payload) || payload.page !== page) throw new Error('TMDB returned an invalid trending response');
    return {
      movies: payload.results.flatMap(mapMovie),
      page: payload.page,
      totalPages: payload.total_pages,
      totalResults: payload.total_results,
    };
  }

  async search(query: string, page: number, locale: Locale, context?: ExternalRequestContext) {
    const url = new URL(`${this.baseUrl}/search/movie`);
    url.searchParams.set('query', query);
    url.searchParams.set('language', locale);
    url.searchParams.set('page', String(page));
    url.searchParams.set('include_adult', 'false');
    const response = await this.request(url, 'movie.search', context);
    const payload = await response.json() as TmdbTrendingResponse;
    if (!isTrendingResponse(payload) || payload.page !== page) throw new Error('TMDB returned an invalid movie search response');
    return {
      movies: payload.results.flatMap(mapMovie),
      page: payload.page,
      totalPages: payload.total_pages,
      totalResults: payload.total_results,
    };
  }

  async fetchDetails(tmdbId: number, locale: Locale, context?: ExternalRequestContext): Promise<MovieDetailRecord> {
    const url = new URL(`${this.baseUrl}/movie/${tmdbId}`);
    url.searchParams.set('language', locale);
    url.searchParams.set('append_to_response', 'credits,translations,videos');
    url.searchParams.set('include_video_language', videoLanguages(locale).join(','));
    const response = await this.request(url, 'movie.details', context);
    const payload = await response.json() as TmdbDetail;
    const localized = selectRequestedTranslation(payload, locale);
    const [summary] = mapMovie({
      ...payload,
      ...localized,
      ...(payload.genres ? { genre_ids: payload.genres.map(({ id }) => id) } : {}),
    });
    if (!summary || payload.id !== tmdbId) throw new Error('TMDB returned an invalid movie detail response');
    const cast = (payload.credits?.cast ?? []).slice(0, 20).flatMap((person): CreditRecord[] => {
      if (!validPerson(person) || !person.credit_id) return [];
      return [{ person: mapPerson(person), creditId: person.credit_id, type: 'cast',
        ...(person.character?.trim() ? { character: person.character.trim() } : {}),
        ...(Number.isInteger(person.order) ? { order: person.order } : {}),
      }];
    });
    const directors = (payload.credits?.crew ?? []).flatMap((person): CreditRecord[] => {
      if (person.job !== 'Director' || !validPerson(person) || !person.credit_id) return [];
      return [{ person: mapPerson(person), creditId: person.credit_id, type: 'director' }];
    });
    return {
      ...summary,
      ...(payload.imdb_id?.trim() ? { imdbId: payload.imdb_id.trim() } : {}),
      ...(localized.tagline?.trim() ? { tagline: localized.tagline.trim() } : {}),
      ...(typeof payload.runtime === 'number' && payload.runtime >= 0 ? { runtimeMinutes: payload.runtime } : {}),
      genres: (payload.genres ?? []).flatMap((genre) => Number.isInteger(genre.id) && genre.id > 0 && genre.name?.trim()
        ? [{ tmdbId: genre.id, name: genre.name.trim() }] : []),
      ...selectTrailer(payload.videos?.results, locale),
      cast, directors,
    };
  }

  async discover(filters: { genres: number[]; excludeGenres: number[]; maxRuntime: number | null; language: string | null }, page: number, locale: Locale, ownerId: string): Promise<MovieRecord[]> {
    const url = new URL(`${this.baseUrl}/discover/movie`);
    url.searchParams.set('language', locale); url.searchParams.set('page', String(page));
    url.searchParams.set('include_adult', 'false'); url.searchParams.set('sort_by', 'popularity.desc');
    url.searchParams.set('primary_release_date.lte', new Date().toISOString().slice(0, 10));
    if (filters.genres.length) url.searchParams.set('with_genres', filters.genres.join(','));
    if (filters.excludeGenres.length) url.searchParams.set('without_genres', filters.excludeGenres.join(','));
    if (filters.maxRuntime) url.searchParams.set('with_runtime.lte', String(filters.maxRuntime));
    if (filters.language) url.searchParams.set('with_original_language', filters.language);
    const payload = await (await this.request(url, 'movie.discover', { actorType: 'user', ownerId, trigger: 'api_request' })).json() as TmdbTrendingResponse;
    if (!isTrendingResponse(payload) || payload.page !== page) throw new Error('Invalid TMDB discovery response');
    return payload.results.flatMap(mapMovie);
  }

  async related(tmdbId: number, locale: Locale, ownerId: string): Promise<MovieRecord[]> {
    const url = new URL(`${this.baseUrl}/movie/${tmdbId}/recommendations`);
    url.searchParams.set('language', locale);
    const payload = await (await this.request(url, 'movie.recommendations', { actorType: 'user', ownerId, trigger: 'api_request' })).json() as TmdbTrendingResponse;
    if (!isTrendingResponse(payload)) throw new Error('Invalid TMDB recommendation response');
    return payload.results.flatMap(mapMovie);
  }

  private async request(url: URL, operation: string, context?: ExternalRequestContext): Promise<Response> {
    const isV3ApiKey = /^[0-9a-f]{32}$/i.test(this.credential);
    if (isV3ApiKey) url.searchParams.set('api_key', this.credential);
    const operationId = randomUUID();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const startedAt = Date.now();
      let response: Response;
      try {
        response = await this.fetcher(url, {
          headers: {
            accept: 'application/json',
            ...(isV3ApiKey ? {} : { authorization: `Bearer ${this.credential}` }),
          },
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (error) {
        await this.record(context, {
          operation, operationId, attempt: attempt + 1, outcome: 'failure',
          errorCode: isTimeoutError(error) ? 'timeout' : 'network',
          durationMs: Date.now() - startedAt,
        });
        throw error;
      }
      await this.record(context, {
        operation, operationId, attempt: attempt + 1,
        outcome: response.ok ? 'success' : 'failure',
        ...(response.ok ? {} : { errorCode: tmdbHttpErrorCode(response.status) }),
        httpStatus: response.status,
        durationMs: Date.now() - startedAt,
      });
      if (response.ok) return response;
      if (response.status !== 429 || attempt === 2) throw new Error(`TMDB request failed with status ${response.status}`);
      const retryAfter = Number(response.headers.get('retry-after'));
      const delayMs = Number.isFinite(retryAfter) && retryAfter >= 0
        ? retryAfter * 1_000
        : (250 * 2 ** attempt) + Math.floor(Math.random() * 150);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    throw new Error('TMDB retry loop ended unexpectedly');
  }

  private async record(
    context: ExternalRequestContext | undefined,
    event: {
      operation: string;
      operationId: string;
      attempt: number;
      outcome: 'success' | 'failure';
      durationMs: number;
      httpStatus?: number;
      errorCode?: ExternalRequestErrorCode;
    },
  ): Promise<void> {
    if (!context || !this.usage) return;
    try {
      await this.usage.record({
        ...context,
        ...event,
        trigger: event.attempt > 1 ? 'retry' : context.trigger,
        provider: 'tmdb',
        occurredAt: new Date(),
      });
    } catch {
      // Usage telemetry must never change the upstream request result.
    }
  }
}

function videoLanguages(locale: Locale): string[] {
  const language = locale.split('-')[0]!;
  return [...new Set([language, 'en', 'null'])];
}

function selectTrailer(videos: TmdbVideo[] | undefined, locale: Locale): Pick<MovieDetailRecord, 'trailer'> {
  const [language, region] = locale.split('-');
  const candidates = (videos ?? []).filter((video) =>
    video.site === 'YouTube'
    && video.type === 'Trailer'
    && Boolean(video.id?.trim())
    && Boolean(video.key?.trim())
    && Boolean(video.name?.trim())
    && /^[A-Za-z0-9_-]+$/.test(video.key!.trim()),
  );
  candidates.sort((left, right) => {
    const score = (video: TmdbVideo) =>
      (video.iso_639_1 === language ? 4 : 0)
      + (video.iso_3166_1 === region ? 2 : 0)
      + (video.official ? 1 : 0);
    return score(right) - score(left)
      || Date.parse(right.published_at ?? '') - Date.parse(left.published_at ?? '');
  });
  const selected = candidates[0];
  if (!selected) return {};
  const publishedAt = selected.published_at ? new Date(selected.published_at) : undefined;
  return { trailer: {
    tmdbVideoId: selected.id!.trim(),
    provider: 'youtube',
    providerVideoId: selected.key!.trim(),
    name: selected.name!.trim(),
    ...(selected.iso_639_1 ? { language: selected.iso_639_1 } : {}),
    ...(selected.iso_3166_1 ? { region: selected.iso_3166_1 } : {}),
    official: selected.official === true,
    ...(publishedAt && !Number.isNaN(publishedAt.getTime()) ? { publishedAt } : {}),
  } };
}

function tmdbHttpErrorCode(status: number): ExternalRequestErrorCode {
  if (status === 401) return 'authentication';
  if (status === 403) return 'permission';
  if (status === 429) return 'rate_limited';
  return 'remote_error';
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
}

function selectRequestedTranslation(
  payload: TmdbDetail,
  locale: Locale,
): { title?: string; overview?: string; tagline?: string } {
  const [language, region] = locale.split('-');
  const translation = payload.translations?.translations?.find((candidate) =>
    candidate.iso_639_1 === language && candidate.iso_3166_1 === region,
  )?.data;
  // TMDB may omit an exact translation. In that case its top-level fields are the
  // documented language/original-language fallback for this one requested locale.
  const title = translation?.title?.trim() || payload.title;
  const overview = translation?.overview?.trim() || payload.overview;
  const tagline = translation?.tagline?.trim() || payload.tagline;
  return {
    ...(title ? { title } : {}),
    ...(overview ? { overview } : {}),
    ...(tagline ? { tagline } : {}),
  };
}

function validPerson(person: { id: number; name?: string }): person is typeof person & { name: string } {
  return Number.isInteger(person.id) && person.id > 0 && Boolean(person.name?.trim());
}

function mapPerson(person: { id: number; name: string; original_name?: string; profile_path?: string | null }) {
  return { tmdbId: person.id, name: person.name.trim(),
    ...(person.original_name?.trim() ? { originalName: person.original_name.trim() } : {}),
    ...(person.profile_path ? { profilePath: person.profile_path } : {}),
  };
}

function mapMovie(movie: TmdbMovie): MovieRecord[] {
  if (!Number.isInteger(movie.id) || movie.id < 1 || !movie.title?.trim()) return [];
  const result: MovieRecord = { tmdbId: movie.id, title: movie.title.trim(), genreIds: movie.genre_ids ?? [] };
  if (movie.original_title?.trim()) result.originalTitle = movie.original_title.trim();
  if (movie.original_language?.trim()) result.originalLanguage = movie.original_language.trim();
  if (movie.overview?.trim()) result.overview = movie.overview.trim();
  if (movie.release_date && /^\d{4}-\d{2}-\d{2}$/.test(movie.release_date)) result.releaseDate = movie.release_date;
  if (movie.poster_path) result.posterPath = movie.poster_path;
  if (movie.backdrop_path) result.backdropPath = movie.backdrop_path;
  if (typeof movie.vote_average === 'number') result.voteAverage = movie.vote_average;
  if (typeof movie.vote_count === 'number') result.voteCount = movie.vote_count;
  return [result];
}

function isTrendingResponse(value: unknown): value is TmdbTrendingResponse {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<TmdbTrendingResponse>;
  return Number.isInteger(candidate.page) && Array.isArray(candidate.results)
    && Number.isInteger(candidate.total_pages) && Number.isInteger(candidate.total_results);
}
