import { Type, type Static } from '@sinclair/typebox';
import { LocaleSchema } from '../common/locale.schema.js';
import { TvEpisodeSchema } from './tv-episode.schema.js';

export const TvSeasonSummarySchema = Type.Object({
  tmdbId: Type.Integer({ minimum: 1 }),
  tvShowTmdbId: Type.Integer({ minimum: 1 }),
  seasonNumber: Type.Integer({ minimum: 0 }),
  name: Type.String(),
  overview: Type.Optional(Type.String()),
  posterUrl: Type.Optional(Type.String({ format: 'uri' })),
  airDate: Type.Optional(Type.String({ format: 'date' })),
  episodeCount: Type.Optional(Type.Integer({ minimum: 0 })),
  voteAverage: Type.Optional(Type.Number({ minimum: 0, maximum: 10 })),
}, { additionalProperties: false });
export const TvSeasonDetailSchema = Type.Object({
  ...TvSeasonSummarySchema.properties,
  episodes: Type.Array(TvEpisodeSchema),
  detailSyncedAt: Type.String({ format: 'date-time' }),
  stale: Type.Boolean(),
  locale: LocaleSchema,
}, { additionalProperties: false });
export const TvSeasonParamsSchema = Type.Object({
  tmdbId: Type.Integer({ minimum: 1 }),
  seasonNumber: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false });
export type TvSeasonSummary = Static<typeof TvSeasonSummarySchema>;
export type TvSeasonDetail = Static<typeof TvSeasonDetailSchema>;
export type TvSeasonParams = Static<typeof TvSeasonParamsSchema>;
