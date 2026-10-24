import { Type, type Static } from '@sinclair/typebox';
import { MoviePreferenceSchema } from '../movie-statuses/movie-status.schema.js';
import { MovieTrailerSchema } from '../movies/movie.schema.js';
import { LocaleSchema } from '../common/locale.schema.js';
import { TvSeasonSummarySchema } from './tv-season.schema.js';

export const TvShowSummarySchema = Type.Object({
  mediaType: Type.Literal('tv'),
  userPreference: Type.Optional(MoviePreferenceSchema),
  tmdbId: Type.Integer({ minimum: 1 }),
  name: Type.String(),
  originalName: Type.Optional(Type.String()),
  overview: Type.Optional(Type.String()),
  posterUrl: Type.Optional(Type.String({ format: 'uri' })),
  backdropUrl: Type.Optional(Type.String({ format: 'uri' })),
  firstAirDate: Type.Optional(Type.String({ format: 'date' })),
  voteAverage: Type.Optional(Type.Number({ minimum: 0, maximum: 10 })),
}, { additionalProperties: false });
export const TvShowDetailSchema = Type.Object({
  ...TvShowSummarySchema.properties,
  trailer: Type.Optional(MovieTrailerSchema),
  tagline: Type.Optional(Type.String()),
  lastAirDate: Type.Optional(Type.String({ format: 'date' })),
  status: Type.Optional(Type.String()),
  inProduction: Type.Optional(Type.Boolean()),
  voteCount: Type.Optional(Type.Integer({ minimum: 0 })),
  numberOfSeasons: Type.Optional(Type.Integer({ minimum: 0 })),
  numberOfEpisodes: Type.Optional(Type.Integer({ minimum: 0 })),
  genres: Type.Array(Type.Object({ tmdbId: Type.Integer({ minimum: 1 }), name: Type.String() })),
  seasons: Type.Array(TvSeasonSummarySchema),
  detailSyncedAt: Type.String({ format: 'date-time' }),
  stale: Type.Boolean(),
  locale: LocaleSchema,
}, { additionalProperties: false });
export const TvShowParamsSchema = Type.Object({ tmdbId: Type.Integer({ minimum: 1 }) }, { additionalProperties: false });
export const TvLocaleQuerySchema = Type.Object({ locale: Type.Optional(LocaleSchema) }, { additionalProperties: false });
export const TvTrendingQuerySchema = Type.Object({
  locale: Type.Optional(LocaleSchema),
  page: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, default: 1 })),
  generation: Type.Optional(Type.String({ format: 'uuid' })),
}, { additionalProperties: false });
export const TvTrendingResponseSchema = Type.Object({
  items: Type.Array(TvShowSummarySchema),
  page: Type.Integer({ minimum: 1 }),
  hasMore: Type.Boolean(),
  generation: Type.String({ format: 'uuid' }),
  fetchedAt: Type.String({ format: 'date-time' }),
  stale: Type.Boolean(),
  locale: LocaleSchema,
}, { additionalProperties: false });
export type TvShowSummary = Static<typeof TvShowSummarySchema>;
export type TvShowDetail = Static<typeof TvShowDetailSchema>;
export type TvShowParams = Static<typeof TvShowParamsSchema>;
export type TvLocaleQuery = Static<typeof TvLocaleQuerySchema>;
export type TvTrendingQuery = Static<typeof TvTrendingQuerySchema>;
export type TvTrendingResponse = Static<typeof TvTrendingResponseSchema>;

export const TvSearchQuerySchema = Type.Object({
  query: Type.String({ minLength: 1, maxLength: 100, pattern: '\\S' }),
  locale: Type.Optional(LocaleSchema),
  page: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, default: 1 })),
}, { additionalProperties: false });
export const TvSearchResponseSchema = Type.Object({
  items: Type.Array(TvShowSummarySchema),
  page: Type.Integer({ minimum: 1 }),
  hasMore: Type.Boolean(),
  stale: Type.Literal(false),
  locale: LocaleSchema,
}, { additionalProperties: false });
export type TvSearchQuery = Static<typeof TvSearchQuerySchema>;
export type TvSearchResponse = Static<typeof TvSearchResponseSchema>;
