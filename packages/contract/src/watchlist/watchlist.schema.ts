import { Type, type Static } from '@sinclair/typebox';
import { LocaleSchema } from '../common/locale.schema.js';

export const WatchlistMediaTypeSchema = Type.Union([Type.Literal('movie'), Type.Literal('tv')]);
export const WatchlistQuerySchema = Type.Object({
  mediaType: WatchlistMediaTypeSchema,
  page: Type.Optional(Type.Integer({ minimum: 1, default: 1 })),
  pageSize: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, default: 20 })),
  locale: Type.Optional(LocaleSchema),
}, { additionalProperties: false });
export const WatchlistItemSchema = Type.Object({
  mediaType: WatchlistMediaTypeSchema,
  tmdbId: Type.Integer({ minimum: 1 }),
  title: Type.String(),
  resourceNotificationEnabled: Type.Optional(Type.Boolean()),
  overview: Type.Optional(Type.String()),
  posterUrl: Type.Optional(Type.String({ format: 'uri' })),
  releaseDate: Type.Optional(Type.String({ format: 'date' })),
  voteAverage: Type.Optional(Type.Number({ minimum: 0, maximum: 10 })),
}, { additionalProperties: false });
export const WatchlistResponseSchema = Type.Object({
  items: Type.Array(WatchlistItemSchema),
  pagination: Type.Object({ page: Type.Integer({ minimum: 1 }), pageSize: Type.Integer({ minimum: 1 }), total: Type.Integer({ minimum: 0 }), hasMore: Type.Boolean() }),
  locale: LocaleSchema,
}, { additionalProperties: false });
export const WatchlistMembershipSchema = Type.Object({ inWatchlist: Type.Boolean() }, { additionalProperties: false });
export type WatchlistMediaType = Static<typeof WatchlistMediaTypeSchema>;
export type WatchlistQuery = Static<typeof WatchlistQuerySchema>;
export type WatchlistItem = Static<typeof WatchlistItemSchema>;
export type WatchlistResponse = Static<typeof WatchlistResponseSchema>;
export type WatchlistMembership = Static<typeof WatchlistMembershipSchema>;

export const WatchlistItemParamsSchema = Type.Object({
  mediaType: WatchlistMediaTypeSchema,
  tmdbId: Type.Integer({ minimum: 1 }),
}, { additionalProperties: false });
export const WatchlistResourceNotificationSchema = Type.Object({ enabled: Type.Boolean() }, { additionalProperties: false });
export type WatchlistItemParams = Static<typeof WatchlistItemParamsSchema>;
export type WatchlistResourceNotification = Static<typeof WatchlistResourceNotificationSchema>;
