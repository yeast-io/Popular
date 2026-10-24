import { Schema, type Connection, type InferSchemaType } from 'mongoose';

const schema = new Schema({
  tvShowTmdbId: { type: Number, min: 1, validate: Number.isInteger, required: true },
  seasonNumber: { type: Number, min: 0, validate: Number.isInteger, required: true },
  locale: { type: String, required: true, enum: ['en-US', 'zh-CN'] },
  name: { type: String, default: '' },
  overview: { type: String },
  posterPath: { type: String },
  summarySyncedAt: { type: Date },
  detailSyncedAt: { type: Date },
  episodeListSyncedAt: { type: Date },
}, { timestamps: true, collection: 'tv_season_localizations' });
schema.index({ tvShowTmdbId: 1, seasonNumber: 1, locale: 1 }, { unique: true });
export type TvSeasonLocalizationDocument = InferSchemaType<typeof schema>;
export const createTvSeasonLocalizationModel = (connection: Connection) => connection.model<TvSeasonLocalizationDocument>('TvSeasonLocalization', schema);
