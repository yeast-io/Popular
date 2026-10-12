import type { Locale } from '@movie-hub/contract';
import type { CreditRecord, MovieDetailRecord, MovieRecord, TrendingProvider } from '../../modules/movies/movie.types.js';

interface TmdbMovie {
  id: number;
  title?: string;
  original_title?: string;
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
}

export class TmdbClient implements TrendingProvider {
  constructor(
    private readonly credential: string,
    private readonly timeoutMs: number,
    private readonly baseUrl = 'https://api.themoviedb.org/3',
    private readonly fetcher: typeof fetch = globalThis.fetch,
  ) {}

  async fetchPage(page: number, locale: Locale) {
    const url = new URL(`${this.baseUrl}/trending/movie/week`);
    url.searchParams.set('language', locale);
    url.searchParams.set('page', String(page));
    const response = await this.request(url);
    const payload = await response.json() as TmdbTrendingResponse;
    if (!isTrendingResponse(payload) || payload.page !== page) throw new Error('TMDB returned an invalid trending response');
    return {
      movies: payload.results.flatMap(mapMovie),
      page: payload.page,
      totalPages: payload.total_pages,
      totalResults: payload.total_results,
    };
  }

  async search(query: string, page: number, locale: Locale) {
    const url = new URL(`${this.baseUrl}/search/movie`);
    url.searchParams.set('query', query);
    url.searchParams.set('language', locale);
    url.searchParams.set('page', String(page));
    url.searchParams.set('include_adult', 'false');
    const response = await this.request(url);
    const payload = await response.json() as TmdbTrendingResponse;
    if (!isTrendingResponse(payload) || payload.page !== page) throw new Error('TMDB returned an invalid movie search response');
    return {
      movies: payload.results.flatMap(mapMovie),
      page: payload.page,
      totalPages: payload.total_pages,
      totalResults: payload.total_results,
    };
  }

  async fetchDetails(tmdbId: number, locale: Locale): Promise<MovieDetailRecord> {
    const url = new URL(`${this.baseUrl}/movie/${tmdbId}`);
    url.searchParams.set('language', locale);
    url.searchParams.set('append_to_response', 'credits,translations');
    const response = await this.request(url);
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
      cast, directors,
    };
  }

  private async request(url: URL): Promise<Response> {
    const isV3ApiKey = /^[0-9a-f]{32}$/i.test(this.credential);
    if (isV3ApiKey) url.searchParams.set('api_key', this.credential);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await this.fetcher(url, {
        headers: {
          accept: 'application/json',
          ...(isV3ApiKey ? {} : { authorization: `Bearer ${this.credential}` }),
        },
        signal: AbortSignal.timeout(this.timeoutMs),
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
