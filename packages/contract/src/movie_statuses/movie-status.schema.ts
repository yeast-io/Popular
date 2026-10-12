import { Static, Type } from '@sinclair/typebox';
import { LocaleSchema } from '../common/locale.schema.js';

export const movieStatuses = ['unwatched', 'watched', 'interested', 'not_interested'] as const;
export const MovieStatusSchema = Type.Union(movieStatuses.map((status) => Type.Literal(status)));
export type MovieStatus = Static<typeof MovieStatusSchema>;

export const trackedMovieStatuses = ['watched', 'interested', 'not_interested'] as const;
export const TrackedMovieStatusSchema = Type.Union(trackedMovieStatuses.map((status) => Type.Literal(status)));

export const MovieIdParamsSchema = Type.Object({
  tmdbId: Type.Integer({ minimum: 1 }),
}, { additionalProperties: false });

export const SetMovieStatusRequestSchema = Type.Object({
  status: TrackedMovieStatusSchema,
}, { additionalProperties: false });

export const MovieStatusResponseSchema = Type.Object({
  tmdbId: Type.Integer({ minimum: 1 }),
  status: MovieStatusSchema,
}, { additionalProperties: false });

export const MyMoviesQuerySchema = Type.Object({
  status: Type.Optional(TrackedMovieStatusSchema),
  page: Type.Optional(Type.Integer({ minimum: 1, default: 1 })),
  pageSize: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, default: 20 })),
  locale: Type.Optional(LocaleSchema),
}, { additionalProperties: false });

export const MovieResourceAvailabilitySchema = Type.Union([
  Type.Literal('available'),
  Type.Literal('unavailable'),
  Type.Literal('unchecked'),
  Type.Literal('unmatchable'),
]);

export const MovieResourceCheckSchema = Type.Object({
  provider: Type.Literal('mteam'),
  availability: MovieResourceAvailabilitySchema,
  checkedAt: Type.Optional(Type.String({ format: 'date-time' })),
  expiresAt: Type.Optional(Type.String({ format: 'date-time' })),
  lastAttemptAt: Type.Optional(Type.String({ format: 'date-time' })),
  lastAttemptStatus: Type.Optional(Type.Union([Type.Literal('success'), Type.Literal('error')])),
  lastErrorCode: Type.Optional(Type.Union([
    Type.Literal('authentication'),
    Type.Literal('permission'),
    Type.Literal('network'),
    Type.Literal('timeout'),
    Type.Literal('rate_limited'),
    Type.Literal('invalid_response'),
    Type.Literal('remote_error'),
    Type.Literal('internal_error'),
  ])),
}, { additionalProperties: false });

export const MyMoviesResponseSchema = Type.Object({
  items: Type.Array(Type.Object({
    tmdbId: Type.Integer({ minimum: 1 }),
    title: Type.String({ minLength: 1 }),
    originalTitle: Type.Optional(Type.String()),
    overview: Type.Optional(Type.String()),
    releaseDate: Type.Optional(Type.String({ format: 'date' })),
    posterUrl: Type.Optional(Type.String({ format: 'uri' })),
    voteAverage: Type.Optional(Type.Number({ minimum: 0, maximum: 10 })),
    userStatus: TrackedMovieStatusSchema,
    resourceCheck: Type.Optional(MovieResourceCheckSchema),
  }, { additionalProperties: false })),
  pagination: Type.Object({
    page: Type.Integer({ minimum: 1 }),
    pageSize: Type.Integer({ minimum: 1 }),
    total: Type.Integer({ minimum: 0 }),
    hasMore: Type.Boolean(),
  }, { additionalProperties: false }),
  locale: LocaleSchema,
}, { additionalProperties: false });

export type TrackedMovieStatus = Static<typeof TrackedMovieStatusSchema>;
export type MovieIdParams = Static<typeof MovieIdParamsSchema>;
export type SetMovieStatusRequest = Static<typeof SetMovieStatusRequestSchema>;
export type MovieStatusResponse = Static<typeof MovieStatusResponseSchema>;
export type MyMoviesQuery = Static<typeof MyMoviesQuerySchema>;
export type MyMoviesResponse = Static<typeof MyMoviesResponseSchema>;
export type MovieResourceAvailability = Static<typeof MovieResourceAvailabilitySchema>;
export type MovieResourceCheck = Static<typeof MovieResourceCheckSchema>;
