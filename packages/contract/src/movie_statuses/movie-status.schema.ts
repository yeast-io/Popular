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

export const MovieResourceErrorCodeSchema = Type.Union([
  Type.Literal('MTEAM_AUTH_FAILED'),
  Type.Literal('MTEAM_UNREACHABLE'),
  Type.Literal('MTEAM_TIMEOUT'),
  Type.Literal('MTEAM_RATE_LIMITED'),
  Type.Literal('MTEAM_UNEXPECTED_RESPONSE'),
]);

export const MovieResourceCheckSchema = Type.Object({
  provider: Type.Literal('mteam'),
  checking: Type.Boolean(),
  availability: MovieResourceAvailabilitySchema,
  checkedAt: Type.Optional(Type.String({ format: 'date-time' })),
  expiresAt: Type.Optional(Type.String({ format: 'date-time' })),
  lastAttemptAt: Type.Optional(Type.String({ format: 'date-time' })),
  lastAttemptStatus: Type.Optional(Type.Union([Type.Literal('success'), Type.Literal('error')])),
  lastErrorCode: Type.Optional(MovieResourceErrorCodeSchema),
}, { additionalProperties: false });

export const MovieResourceCheckResponseSchema = MovieResourceCheckSchema;

export const MovieReleaseSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  title: Type.String({ minLength: 1 }),
  sizeBytes: Type.Optional(Type.Integer({ minimum: 0 })),
  seeders: Type.Integer({ minimum: 0 }),
  leechers: Type.Optional(Type.Integer({ minimum: 0 })),
  publishedAt: Type.Optional(Type.String({ minLength: 1 })),
  discount: Type.Optional(Type.String({ minLength: 1 })),
  resolution: Type.Optional(Type.String({ minLength: 1 })),
  medium: Type.Optional(Type.String({ minLength: 1 })),
  videoCodec: Type.Optional(Type.String({ minLength: 1 })),
  audioCodec: Type.Optional(Type.String({ minLength: 1 })),
  tags: Type.Array(Type.String({ minLength: 1 })),
}, { additionalProperties: false });

export const MovieReleaseListResponseSchema = Type.Object({
  provider: Type.Literal('mteam'),
  availability: MovieResourceAvailabilitySchema,
  queriedAt: Type.String({ format: 'date-time' }),
  cached: Type.Boolean(),
  releases: Type.Array(MovieReleaseSchema),
}, { additionalProperties: false });

export const StartMovieResourceSyncRequestSchema = Type.Object({
  force: Type.Optional(Type.Boolean({ default: false })),
}, { additionalProperties: false });

export const MovieResourceSyncParamsSchema = Type.Object({
  jobId: Type.String({ minLength: 24, maxLength: 24, pattern: '^[a-fA-F0-9]{24}$' }),
}, { additionalProperties: false });

export const MovieResourceSyncStatusSchema = Type.Union([
  Type.Literal('queued'),
  Type.Literal('running'),
  Type.Literal('paused'),
  Type.Literal('completed'),
  Type.Literal('failed'),
  Type.Literal('cancelled'),
]);

export const MovieResourceSyncBatchSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  status: MovieResourceSyncStatusSchema,
  total: Type.Integer({ minimum: 0 }),
  completed: Type.Integer({ minimum: 0 }),
  available: Type.Integer({ minimum: 0 }),
  unavailable: Type.Integer({ minimum: 0 }),
  unmatchable: Type.Integer({ minimum: 0 }),
  failed: Type.Integer({ minimum: 0 }),
  createdAt: Type.String({ format: 'date-time' }),
  updatedAt: Type.String({ format: 'date-time' }),
  resumeAt: Type.Optional(Type.String({ format: 'date-time' })),
  needsAction: Type.Optional(Type.Literal('update_api_key')),
}, { additionalProperties: false });
export const CurrentMovieResourceSyncBatchSchema = Type.Union([MovieResourceSyncBatchSchema, Type.Null()]);

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
export type MovieResourceCheckResponse = Static<typeof MovieResourceCheckResponseSchema>;
export type MovieRelease = Static<typeof MovieReleaseSchema>;
export type MovieReleaseListResponse = Static<typeof MovieReleaseListResponseSchema>;
export type StartMovieResourceSyncRequest = Static<typeof StartMovieResourceSyncRequestSchema>;
export type MovieResourceSyncParams = Static<typeof MovieResourceSyncParamsSchema>;
export type MovieResourceSyncStatus = Static<typeof MovieResourceSyncStatusSchema>;
export type MovieResourceSyncBatch = Static<typeof MovieResourceSyncBatchSchema>;
