import { Type, type Static } from '@sinclair/typebox';

export const TvEpisodeSchema = Type.Object({
  tmdbId: Type.Integer({ minimum: 1 }),
  tvShowTmdbId: Type.Integer({ minimum: 1 }),
  seasonNumber: Type.Integer({ minimum: 0 }),
  episodeNumber: Type.Integer({ minimum: 1 }),
  name: Type.String(),
  overview: Type.Optional(Type.String()),
  stillUrl: Type.Optional(Type.String({ format: 'uri' })),
  episodeType: Type.Optional(Type.String()),
  airDate: Type.Optional(Type.String({ format: 'date' })),
  runtimeMinutes: Type.Optional(Type.Integer({ minimum: 0 })),
  voteAverage: Type.Optional(Type.Number({ minimum: 0, maximum: 10 })),
  voteCount: Type.Optional(Type.Integer({ minimum: 0 })),
}, { additionalProperties: false });
export type TvEpisode = Static<typeof TvEpisodeSchema>;
