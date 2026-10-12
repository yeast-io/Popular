import { supportedLocales } from '@movie-hub/contract';
import { Schema, type Connection, type InferSchemaType } from 'mongoose';

const movieLocalizationSchema = new Schema({
  movieTmdbId: { type: Number, required: true, min: 1 },
  locale: { type: String, required: true, enum: supportedLocales },
  title: { type: String, required: true },
  overview: { type: String },
  tagline: { type: String },
  posterPath: { type: String },
  backdropPath: { type: String },
  genres: {
    type: [{ tmdbId: { type: Number, required: true }, name: { type: String, required: true } }],
    default: undefined,
    _id: false,
  },
  summarySyncedAt: { type: Date, required: true },
  detailSyncedAt: { type: Date },
  // Operational pointer used to publish a complete credit snapshot atomically.
  activeCreditVersion: { type: String },
}, { timestamps: true, collection: 'movie_localizations' });

movieLocalizationSchema.index({ movieTmdbId: 1, locale: 1 }, { unique: true });

export type MovieLocalizationDocument = InferSchemaType<typeof movieLocalizationSchema>;
export const createMovieLocalizationModel = (connection: Connection) =>
  connection.model<MovieLocalizationDocument>('MovieLocalization', movieLocalizationSchema);
