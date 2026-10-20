import { Type, type Static } from '@sinclair/typebox';
import { MovieReleaseSchema, MovieResourceAvailabilitySchema } from '../movie-statuses/movie-status.schema.js';

export const MovieSiteResourceParamsSchema = Type.Object({
  tmdbId: Type.Integer({ minimum: 1 }), site: Type.String({ pattern: '^[a-z][a-z0-9-]{0,31}$' }),
}, { additionalProperties: false });
export const MovieSiteResourceQuerySchema = Type.Object({
  page: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
}, { additionalProperties: false });
export const MovieSiteReleaseListSchema = Type.Object({
  site: Type.String(), name: Type.String(), supportsDownload: Type.Boolean(),
  availability: MovieResourceAvailabilitySchema,
  queriedAt: Type.String({ format: 'date-time' }), cached: Type.Boolean(),
  releases: Type.Array(Type.Composite([MovieReleaseSchema, Type.Object({ seedersKnown: Type.Optional(Type.Boolean()) })])),
  nextPage: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
}, { additionalProperties: false });
export type MovieSiteReleaseList = Static<typeof MovieSiteReleaseListSchema>;
export type MovieSiteResourceParams = Static<typeof MovieSiteResourceParamsSchema>;
export type MovieSiteResourceQuery = Static<typeof MovieSiteResourceQuerySchema>;
