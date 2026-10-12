import { Static, Type } from '@sinclair/typebox';
import { LocaleSchema } from '../common/locale.schema.js';
import { MovieStatusSchema } from '../movie_statuses/movie-status.schema.js';

export const MovieSummarySchema = Type.Object({
  tmdbId: Type.Integer({ minimum: 1 }),
  title: Type.String({ minLength: 1 }),
  originalTitle: Type.Optional(Type.String()),
  overview: Type.Optional(Type.String()),
  releaseDate: Type.Optional(Type.String({ format: 'date' })),
  posterUrl: Type.Optional(Type.String({ format: 'uri' })),
  voteAverage: Type.Optional(Type.Number({ minimum: 0, maximum: 10 })),
  userStatus: MovieStatusSchema,
}, { additionalProperties: false });

export const MoviePersonSchema = Type.Object({
  tmdbId: Type.Integer({ minimum: 1 }),
  name: Type.String({ minLength: 1 }),
  character: Type.Optional(Type.String()),
  profileUrl: Type.Optional(Type.String({ format: 'uri' })),
}, { additionalProperties: false });

export const MovieDetailSchema = Type.Object({
  tmdbId: Type.Integer({ minimum: 1 }),
  imdbId: Type.Optional(Type.String()),
  title: Type.String({ minLength: 1 }),
  originalTitle: Type.Optional(Type.String()),
  overview: Type.Optional(Type.String()),
  tagline: Type.Optional(Type.String()),
  runtimeMinutes: Type.Optional(Type.Integer({ minimum: 0 })),
  genres: Type.Array(Type.Object({ tmdbId: Type.Integer({ minimum: 1 }), name: Type.String({ minLength: 1 }) }, { additionalProperties: false })),
  releaseDate: Type.Optional(Type.String({ format: 'date' })),
  posterUrl: Type.Optional(Type.String({ format: 'uri' })),
  backdropUrl: Type.Optional(Type.String({ format: 'uri' })),
  voteAverage: Type.Optional(Type.Number({ minimum: 0, maximum: 10 })),
  voteCount: Type.Optional(Type.Integer({ minimum: 0 })),
  cast: Type.Array(MoviePersonSchema),
  directors: Type.Array(MoviePersonSchema),
  userStatus: MovieStatusSchema,
  detailSyncedAt: Type.String({ format: 'date-time' }),
  stale: Type.Boolean(),
  locale: LocaleSchema,
}, { additionalProperties: false });

export const MovieDetailParamsSchema = Type.Object({ tmdbId: Type.Integer({ minimum: 1 }) }, { additionalProperties: false });
export const MovieDetailQuerySchema = Type.Object({
  locale: Type.Optional(LocaleSchema),
}, { additionalProperties: false });

export const TrendingQuerySchema = Type.Object({
  page: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, default: 1 })),
  locale: Type.Optional(LocaleSchema),
}, { additionalProperties: false });

export const LoadMoreTrendingRequestSchema = Type.Object({
  page: Type.Integer({ minimum: 1, maximum: 49 }),
  locale: Type.Optional(LocaleSchema),
}, { additionalProperties: false });

export const TrendingMoviesResponseSchema = Type.Object({
  items: Type.Array(MovieSummarySchema),
  page: Type.Integer({ minimum: 1 }),
  hasMore: Type.Boolean(),
  source: Type.Literal('cache'),
  resultCompleteness: Type.Literal('complete'),
  fetchedAt: Type.String({ format: 'date-time' }),
  locale: LocaleSchema,
}, { additionalProperties: false });

export const SearchMoviesQuerySchema = Type.Object({
  query: Type.String({ minLength: 1, maxLength: 100 }),
  page: Type.Optional(Type.Integer({ minimum: 1, maximum: 500, default: 1 })),
  locale: Type.Optional(LocaleSchema),
}, { additionalProperties: false });

export const SearchMoviesResponseSchema = Type.Object({
  items: Type.Array(MovieSummarySchema),
  page: Type.Integer({ minimum: 1 }),
  hasMore: Type.Boolean(),
  source: Type.Union([Type.Literal('cache'), Type.Literal('tmdb'), Type.Literal('local-fallback')]),
  resultCompleteness: Type.Union([Type.Literal('complete'), Type.Literal('partial')]),
  locale: LocaleSchema,
}, { additionalProperties: false });

export type MovieSummary = Static<typeof MovieSummarySchema>;
export type MoviePerson = Static<typeof MoviePersonSchema>;
export type MovieDetail = Static<typeof MovieDetailSchema>;
export type MovieDetailParams = Static<typeof MovieDetailParamsSchema>;
export type MovieDetailQuery = Static<typeof MovieDetailQuerySchema>;
export type TrendingQuery = Static<typeof TrendingQuerySchema>;
export type LoadMoreTrendingRequest = Static<typeof LoadMoreTrendingRequestSchema>;
export type TrendingMoviesResponse = Static<typeof TrendingMoviesResponseSchema>;
export type SearchMoviesQuery = Static<typeof SearchMoviesQuerySchema>;
export type SearchMoviesResponse = Static<typeof SearchMoviesResponseSchema>;
