import { Schema, type Connection, type InferSchemaType } from 'mongoose';

const schema = new Schema({
  tmdbId: { type: Number, min: 1, validate: Number.isInteger, required: true },
  originalName: { type: String },
  originalLanguage: { type: String },
  firstAirDate: { type: Date },
  lastAirDate: { type: Date },
  status: { type: String },
  inProduction: { type: Boolean },
  genreIds: { type: [Number], default: undefined },
  voteAverage: { type: Number, min: 0, max: 10 },
  voteCount: { type: Number, min: 0, validate: Number.isInteger },
  numberOfSeasons: { type: Number, min: 0, validate: Number.isInteger },
  numberOfEpisodes: { type: Number, min: 0, validate: Number.isInteger },
  summarySyncedAt: { type: Date },
  detailSyncedAt: { type: Date },
}, { timestamps: true, collection: 'tv_shows' });
schema.index({ tmdbId: 1 }, { unique: true });
export type TvShowDocument = InferSchemaType<typeof schema>;
export const createTvShowModel = (connection: Connection) => connection.model<TvShowDocument>('TvShow', schema);
