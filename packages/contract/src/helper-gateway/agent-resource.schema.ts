import { Type, type Static } from '@sinclair/typebox';
import { ResourceSiteReleaseSchema } from '../integrations/resource-site.schema.js';

const publicRelease = Type.Omit(ResourceSiteReleaseSchema, ['detailsUrl']);
const closed = { additionalProperties: false } as const;
export const AgentResourceSiteSchema = Type.Union(
  (['mteam', 'hdarea', 'hdwing'] as const).map((value) => Type.Literal(value))
);
const resourceId = Type.String({ pattern: '^[0-9]{1,32}$' });
const requestId = Type.String({ pattern: '^[A-Za-z0-9_-]{1,160}$' });
export const AgentResourceRequestSchema = Type.Union([
  Type.Object({ operation: Type.Literal('list') }, closed),
  Type.Object(
    {
      operation: Type.Literal('search'),
      site: AgentResourceSiteSchema,
      query: Type.Optional(Type.String({ minLength: 1, maxLength: 200, pattern: '\\S' })),
      imdbId: Type.Optional(Type.String({ pattern: '^tt[0-9]{1,20}$' })),
      page: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
      mediaType: Type.Optional(Type.Union([Type.Literal('movie'), Type.Literal('tv')])),
    },
    { ...closed, anyOf: [{ required: ['query'] }, { required: ['imdbId'] }] }
  ),
  Type.Object({ operation: Type.Literal('detail'), site: AgentResourceSiteSchema, resourceId }, closed),
  Type.Object(
    {
      operation: Type.Literal('prepare'),
      site: AgentResourceSiteSchema,
      resourceId,
      commandId: requestId,
      version: Type.String({ pattern: '^[a-f0-9]{64}$' }),
    },
    closed
  ),
]);
export const AgentResourceSitesSchema = Type.Array(
  Type.Object(
    {
      site: AgentResourceSiteSchema,
      enabled: Type.Boolean(),
      baseUrl: Type.Optional(Type.String({ maxLength: 2048, pattern: '^https://[^?#@]+$' })),
      status: Type.Union(
        (['unconfigured', 'configured_valid', 'configured_invalid'] as const).map((value) => Type.Literal(value))
      ),
      version: Type.String({ maxLength: 64 }),
      verifiedAt: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
    },
    closed
  ),
  { maxItems: 3 }
);
export const AgentPreparedTorrentSchema = Type.Object(
  {
    agentTicket: Type.String({ pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' }),
    torrentHash: Type.String({ pattern: '^(?:[a-f0-9]{40}|[a-f0-9]{64})$' }),
  },
  closed
);
export const AgentResourceResultSchemas = {
  list: AgentResourceSitesSchema,
  search: Type.Object(
    {
      releases: Type.Array(publicRelease, { maxItems: 100 }),
      nextPage: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    },
    closed
  ),
  detail: publicRelease,
  prepare: AgentPreparedTorrentSchema,
};
export const AgentResourceReplySchema = Type.Union([
  Type.Object({ ok: Type.Literal(true), result: Type.Unknown() }, closed),
  Type.Object({ ok: Type.Literal(false), code: Type.String({ pattern: '^site[A-Za-z]{1,40}$' }) }, closed),
]);
export const AgentResourceModeSchema = Type.Object({ deviceId: Type.Union([requestId, Type.Null()]) }, closed);
export const AgentResourceModeResponseSchema = Type.Object(
  {
    unavailable: Type.Optional(Type.Boolean()),
    deviceId: Type.Union([requestId, Type.Null()]),
    sites: Type.Optional(AgentResourceSitesSchema),
  },
  closed
);
export type AgentResourceRequest = Static<typeof AgentResourceRequestSchema>;
export type AgentResourceSites = Static<typeof AgentResourceSitesSchema>;
export type AgentPreparedTorrent = Static<typeof AgentPreparedTorrentSchema>;
export type AgentResourceMode = Static<typeof AgentResourceModeSchema>;
export type AgentResourceModeResponse = Static<typeof AgentResourceModeResponseSchema>;
