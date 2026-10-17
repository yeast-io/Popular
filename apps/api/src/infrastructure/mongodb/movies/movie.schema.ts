import { Schema, type Connection, type InferSchemaType } from 'mongoose';

const movieSchema = new Schema({
  tmdbId: { type: Number, required: true, min: 1 },
  originalTitle: { type: String },
  // Legacy fallback during the locale-image migration. New writes store these
  // language-sensitive paths in movie_localizations.
  posterPath: { type: String },
  backdropPath: { type: String },
  genreIds: { type: [Number], required: true, default: [] },
  releaseDate: { type: Date },
  voteAverage: { type: Number, min: 0, max: 10 },
  voteCount: { type: Number, min: 0 },
  imdbId: { type: String },
  runtimeMinutes: { type: Number, min: 0 },
}, { timestamps: true, collection: 'movies' });

movieSchema.index({ tmdbId: 1 }, { unique: true });

export type MovieDocument = InferSchemaType<typeof movieSchema>;
export const createMovieModel = (connection: Connection) => connection.model<MovieDocument>('Movie', movieSchema);
