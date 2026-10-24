import { Schema, type Connection, type InferSchemaType } from 'mongoose';

const schema = new Schema({
  tvShowTmdbId: { type: Number, min: 1, validate: Number.isInteger, required: true },
  seasonNumber: { type: Number, min: 0, validate: Number.isInteger, required: true },
  episodeNumber: { type: Number, min: 1, validate: Number.isInteger, required: true },
  locale: { type: String, required: true, enum: ['en-US', 'zh-CN'] },
  name: { type: String, default: '' },
  overview: { type: String },
  stillPath: { type: String },
  detailSyncedAt: { type: Date },
}, { timestamps: true, collection: 'tv_episode_localizations' });
schema.index({ tvShowTmdbId: 1, seasonNumber: 1, locale: 1, episodeNumber: 1 }, { unique: true });
export type TvEpisodeLocalizationDocument = InferSchemaType<typeof schema>;
export const createTvEpisodeLocalizationModel = (connection: Connection) => connection.model<TvEpisodeLocalizationDocument>('TvEpisodeLocalization', schema);
