import { Schema, type Connection, type InferSchemaType } from 'mongoose';

const schema = new Schema({
  tmdbId: { type: Number, min: 1, validate: Number.isInteger, required: true },
  tvShowTmdbId: { type: Number, min: 1, validate: Number.isInteger, required: true },
  seasonNumber: { type: Number, min: 0, validate: Number.isInteger, required: true },
  airDate: { type: Date },
  episodeCount: { type: Number, min: 0, validate: Number.isInteger },
  voteAverage: { type: Number, min: 0, max: 10 },
  summarySyncedAt: { type: Date },
  detailSyncedAt: { type: Date },
}, { timestamps: true, collection: 'tv_seasons' });
schema.index({ tmdbId: 1 }, { unique: true });
schema.index({ tvShowTmdbId: 1, seasonNumber: 1 }, { unique: true });
export type TvSeasonDocument = InferSchemaType<typeof schema>;
export const createTvSeasonModel = (connection: Connection) => connection.model<TvSeasonDocument>('TvSeason', schema);
