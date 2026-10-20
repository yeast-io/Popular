import { Type, type Static } from '@sinclair/typebox';
import { IntegrationStatusSchema } from './integration.schema.js';
export const ResourceSiteParamsSchema = Type.Object({ site: Type.String({ pattern: '^[a-z][a-z0-9-]{0,31}$' }) });
export const ResourceSiteReleaseParamsSchema = Type.Object({
  site: Type.String({ pattern: '^[a-z][a-z0-9-]{0,31}$' }), id: Type.String({ pattern: '^\\d+$', maxLength: 32 }),
});
export const ResourceSiteConfigurationSchema = Type.Object({
  site: Type.String(), status: IntegrationStatusSchema,
  cookieMasked: Type.Optional(Type.String({ minLength: 1, pattern: '•' })),
  passkeyMasked: Type.Optional(Type.String({ minLength: 1, pattern: '•' })),
  verifiedAt: Type.Optional(Type.String({ format: 'date-time' })),
}, { additionalProperties: false });
export const SaveResourceSiteSchema = Type.Object({
  passkey: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
  cookie: Type.Optional(Type.String({ minLength: 1, maxLength: 16384, pattern: '^[^\\r\\n]+$' })) }, { additionalProperties: false });
export const ResourceSiteSearchSchema = Type.Object({
  query: Type.Optional(Type.String({ minLength: 1, maxLength: 200, pattern: '\\S' })),
  imdbId: Type.Optional(Type.String({ pattern: '^tt\\d+$' })),
  page: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
}, { additionalProperties: false, anyOf: [{ required: ['query'] }, { required: ['imdbId'] }] });
export const ResourceSiteReleaseSchema = Type.Object({
  id: Type.String(), title: Type.String(),
  sizeBytes: Type.Optional(Type.Number({ minimum: 0 })),
  seeders: Type.Optional(Type.Integer({ minimum: 0 })),
  imdbId: Type.Optional(Type.String()),
  resolution: Type.Optional(Type.String()),
  publishedAt: Type.Optional(Type.String()),
  medium: Type.Optional(Type.String()),
  videoCodec: Type.Optional(Type.String()),
  audioCodec: Type.Optional(Type.String()),
  releaseGroup: Type.Optional(Type.String()),
  tags: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
}, { additionalProperties: false });
export const ResourceSiteSearchResultSchema = Type.Object({
  releases: Type.Array(ResourceSiteReleaseSchema), nextPage: Type.Optional(Type.Integer({ minimum: 1 })),
}, { additionalProperties: false });
export type ResourceSiteConfiguration = Static<typeof ResourceSiteConfigurationSchema>;
export type ResourceSiteSearch = Static<typeof ResourceSiteSearchSchema>;
export type ResourceSiteRelease = Static<typeof ResourceSiteReleaseSchema>;
export type ResourceSiteParams = Static<typeof ResourceSiteParamsSchema>;
export type ResourceSiteReleaseParams = Static<typeof ResourceSiteReleaseParamsSchema>;
export type SaveResourceSite = Static<typeof SaveResourceSiteSchema>;
