import { Schema, type Connection, type InferSchemaType } from 'mongoose';

const schema = new Schema({
  tvShowTmdbId: { type: Number, min: 1, validate: Number.isInteger, required: true },
  locale: { type: String, required: true, enum: ['en-US', 'zh-CN'] },
  name: { type: String, default: '' },
  overview: { type: String },
  tagline: { type: String },
  taglineSyncedAt: { type: Date },
  posterPath: { type: String },
  backdropPath: { type: String },
  genres: { type: [{ tmdbId: { type: Number, required: true }, name: { type: String, required: true } }], default: undefined, _id: false },
  trailer: {
    type: {
      tmdbVideoId: { type: String, required: true },
      provider: { type: String, enum: ['youtube'], required: true },
      providerVideoId: { type: String, required: true },
      name: { type: String, required: true },
      language: { type: String }, region: { type: String },
      official: { type: Boolean, required: true }, publishedAt: { type: Date },
    }, required: false, _id: false,
  },
  trailerSyncedAt: { type: Date },
  summarySyncedAt: { type: Date },
  detailSyncedAt: { type: Date },
}, { timestamps: true, collection: 'tv_show_localizations' });
schema.index({ tvShowTmdbId: 1, locale: 1 }, { unique: true });
export type TvShowLocalizationDocument = InferSchemaType<typeof schema>;
export const createTvShowLocalizationModel = (connection: Connection) => connection.model<TvShowLocalizationDocument>('TvShowLocalization', schema);
