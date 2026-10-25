import { Static, Type } from '@sinclair/typebox';
import { LocaleSchema } from '../common/locale.schema.js';

export const movieStatuses = ['unwatched', 'watched', 'interested'] as const;
export const MovieStatusSchema = Type.Union(movieStatuses.map((status) => Type.Literal(status)));
export type MovieStatus = Static<typeof MovieStatusSchema>;

export const trackedMovieStatuses = ['watched', 'interested'] as const;
export const TrackedMovieStatusSchema = Type.Union(
  trackedMovieStatuses.map((status) => {
    return Type.Literal(status);
  })
);

export const moviePreferences = ['neutral', 'liked', 'disliked'] as const;
export const MoviePreferenceSchema = Type.Union(
  moviePreferences.map((preference) => {
    return Type.Literal(preference);
  })
);
export const trackedMoviePreferences = ['liked', 'disliked'] as const;
export const TrackedMoviePreferenceSchema = Type.Union(
  trackedMoviePreferences.map((preference) => {
    return Type.Literal(preference);
  })
);

export const MovieIdParamsSchema = Type.Object(
  {
    tmdbId: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false }
);

export const SetMovieStatusRequestSchema = Type.Object(
  {
    status: TrackedMovieStatusSchema,
  },
  { additionalProperties: false }
);

export const SetMoviePreferenceRequestSchema = Type.Object(
  {
    preference: TrackedMoviePreferenceSchema,
  },
  { additionalProperties: false }
);

export const MovieStatusResponseSchema = Type.Object(
  {
    tmdbId: Type.Integer({ minimum: 1 }),
    status: MovieStatusSchema,
  },
  { additionalProperties: false }
);

export const MoviePreferenceResponseSchema = Type.Object(
  {
    tmdbId: Type.Integer({ minimum: 1 }),
    preference: MoviePreferenceSchema,
  },
  { additionalProperties: false }
);

export const myMoviesFilters = [...trackedMovieStatuses, ...trackedMoviePreferences] as const;
export const MyMoviesFilterSchema = Type.Union(
  myMoviesFilters.map((filter) => {
    return Type.Literal(filter);
  })
);

export const MyMoviesQuerySchema = Type.Object(
  {
    status: Type.Optional(MyMoviesFilterSchema),
    page: Type.Optional(Type.Integer({ minimum: 1, default: 1 })),
    pageSize: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, default: 20 })),
    locale: Type.Optional(LocaleSchema),
  },
  { additionalProperties: false }
);

export const MovieResourceAvailabilitySchema = Type.Union([
  Type.Literal('available'),
  Type.Literal('unavailable'),
  Type.Literal('unchecked'),
  Type.Literal('unmatchable'),
]);

export const MovieResourceErrorCodeSchema = Type.Union([
  Type.Literal('RESOURCE_SITE_NOT_CONFIGURED'),
  Type.Literal('RESOURCE_SITE_FAILED'),
  Type.Literal('MTEAM_AUTH_FAILED'),
  Type.Literal('MTEAM_UNREACHABLE'),
  Type.Literal('MTEAM_TIMEOUT'),
  Type.Literal('MTEAM_RATE_LIMITED'),
  Type.Literal('MTEAM_UNEXPECTED_RESPONSE'),
]);

export const MovieResourceSiteCheckSchema = Type.Object(
  {
    provider: Type.String(),
    checking: Type.Boolean(),
    availability: MovieResourceAvailabilitySchema,
    checkedAt: Type.Optional(Type.String({ format: 'date-time' })),
    expiresAt: Type.Optional(Type.String({ format: 'date-time' })),
    lastAttemptAt: Type.Optional(Type.String({ format: 'date-time' })),
    lastAttemptStatus: Type.Optional(Type.Union([Type.Literal('success'), Type.Literal('error')])),
    lastErrorCode: Type.Optional(MovieResourceErrorCodeSchema),
  },
  { additionalProperties: false }
);

export const MovieResourceCheckSchema = Type.Composite([MovieResourceSiteCheckSchema, Type.Object({
  sources: Type.Optional(Type.Array(MovieResourceSiteCheckSchema)),
  incomplete: Type.Optional(Type.Boolean()),
})], { additionalProperties: false });
export const MovieResourceCheckResponseSchema = MovieResourceCheckSchema;

export const MovieReleaseSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    title: Type.String({ minLength: 1 }),
    detailsUrl: Type.String({ minLength: 1, maxLength: 2048 }),
    sizeBytes: Type.Optional(Type.Integer({ minimum: 0 })),
    seeders: Type.Integer({ minimum: 0 }),
    seedersKnown: Type.Optional(Type.Boolean()),
    leechers: Type.Optional(Type.Integer({ minimum: 0 })),
    publishedAt: Type.Optional(Type.String({ minLength: 1 })),
    discount: Type.Optional(Type.String({ minLength: 1 })),
    resolution: Type.Optional(Type.String({ minLength: 1 })),
    medium: Type.Optional(Type.String({ minLength: 1 })),
    videoCodec: Type.Optional(Type.String({ minLength: 1 })),
    audioCodec: Type.Optional(Type.String({ minLength: 1 })),
    releaseGroup: Type.Optional(Type.String({ minLength: 1 })),
    tags: Type.Array(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false }
);

export const MovieReleaseListResponseSchema = Type.Object(
  {
    provider: Type.Literal('mteam'),
    availability: MovieResourceAvailabilitySchema,
    queriedAt: Type.String({ format: 'date-time' }),
    cached: Type.Boolean(),
    cacheExpiresAt: Type.Optional(Type.String({ format: 'date-time' })),
    releases: Type.Array(MovieReleaseSchema),
  },
  { additionalProperties: false }
);

export const StartMovieResourceSyncRequestSchema = Type.Object({}, { additionalProperties: false });

export const MovieResourceSyncParamsSchema = Type.Object(
  {
    jobId: Type.String({ minLength: 24, maxLength: 24, pattern: '^[a-fA-F0-9]{24}$' }),
  },
  { additionalProperties: false }
);

export const MovieResourceSyncStatusSchema = Type.Union([
  Type.Literal('queued'),
  Type.Literal('running'),
  Type.Literal('paused'),
  Type.Literal('completed'),
  Type.Literal('failed'),
  Type.Literal('cancelled'),
]);

export const MovieResourceSyncBatchSchema = Type.Object(
  {
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
  },
  { additionalProperties: false }
);
export const CurrentMovieResourceSyncBatchSchema = Type.Union([MovieResourceSyncBatchSchema, Type.Null()]);

export const MyMoviesResponseSchema = Type.Object(
  {
    items: Type.Array(
      Type.Object(
        {
          tmdbId: Type.Integer({ minimum: 1 }),
          title: Type.String({ minLength: 1 }),
          originalTitle: Type.Optional(Type.String()),
          overview: Type.Optional(Type.String()),
          releaseDate: Type.Optional(Type.String({ format: 'date' })),
          posterUrl: Type.Optional(Type.String({ format: 'uri' })),
          voteAverage: Type.Optional(Type.Number({ minimum: 0, maximum: 10 })),
          userStatus: MovieStatusSchema,
          userPreference: MoviePreferenceSchema,
          resourceCheck: Type.Optional(MovieResourceCheckSchema),
        },
        { additionalProperties: false }
      )
    ),
    pagination: Type.Object(
      {
        page: Type.Integer({ minimum: 1 }),
        pageSize: Type.Integer({ minimum: 1 }),
        total: Type.Integer({ minimum: 0 }),
        hasMore: Type.Boolean(),
      },
      { additionalProperties: false }
    ),
    locale: LocaleSchema,
  },
  { additionalProperties: false }
);

export type TrackedMovieStatus = Static<typeof TrackedMovieStatusSchema>;
export type MoviePreference = Static<typeof MoviePreferenceSchema>;
export type TrackedMoviePreference = Static<typeof TrackedMoviePreferenceSchema>;
export type MyMoviesFilter = Static<typeof MyMoviesFilterSchema>;
export type MovieIdParams = Static<typeof MovieIdParamsSchema>;
export type SetMovieStatusRequest = Static<typeof SetMovieStatusRequestSchema>;
export type SetMoviePreferenceRequest = Static<typeof SetMoviePreferenceRequestSchema>;
export type MovieStatusResponse = Static<typeof MovieStatusResponseSchema>;
export type MoviePreferenceResponse = Static<typeof MoviePreferenceResponseSchema>;
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
