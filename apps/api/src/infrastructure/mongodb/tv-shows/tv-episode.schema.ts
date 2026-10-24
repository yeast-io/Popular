import { Schema, type Connection, type InferSchemaType } from 'mongoose';

const schema = new Schema({
  tmdbId: { type: Number, min: 1, validate: Number.isInteger, required: true },
  tvShowTmdbId: { type: Number, min: 1, validate: Number.isInteger, required: true },
  seasonNumber: { type: Number, min: 0, validate: Number.isInteger, required: true },
  episodeNumber: { type: Number, min: 1, validate: Number.isInteger, required: true },
  episodeType: { type: String },
  airDate: { type: Date },
  runtimeMinutes: { type: Number, min: 0, validate: Number.isInteger },
  voteAverage: { type: Number, min: 0, max: 10 },
  voteCount: { type: Number, min: 0, validate: Number.isInteger },
  detailSyncedAt: { type: Date },
}, { timestamps: true, collection: 'tv_episodes' });
schema.index({ tmdbId: 1 }, { unique: true });
schema.index({ tvShowTmdbId: 1, seasonNumber: 1, episodeNumber: 1 }, { unique: true });
export type TvEpisodeDocument = InferSchemaType<typeof schema>;
export const createTvEpisodeModel = (connection: Connection) => connection.model<TvEpisodeDocument>('TvEpisode', schema);
