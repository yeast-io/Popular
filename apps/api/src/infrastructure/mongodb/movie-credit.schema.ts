import { Schema, type Connection, type InferSchemaType } from 'mongoose';
import { supportedLocales } from '@movie-hub/contract';

const movieCreditSchema = new Schema({
  movieTmdbId: { type: Number, required: true, min: 1 },
  locale: { type: String, required: true, enum: supportedLocales },
  personTmdbId: { type: Number, required: true, min: 1 },
  tmdbCreditId: { type: String, required: true },
  creditType: { type: String, required: true, enum: ['cast', 'director'] },
  character: { type: String },
  castOrder: { type: Number, min: 0 },
  syncVersion: { type: String, required: true },
}, { timestamps: true, collection: 'movie_credits' });

movieCreditSchema.index({ movieTmdbId: 1, locale: 1, syncVersion: 1, tmdbCreditId: 1 }, { unique: true });
movieCreditSchema.index({ movieTmdbId: 1, locale: 1, syncVersion: 1, creditType: 1, castOrder: 1 });
movieCreditSchema.index({ personTmdbId: 1, locale: 1 });

export type MovieCreditDocument = InferSchemaType<typeof movieCreditSchema>;
export const createMovieCreditModel = (connection: Connection) => connection.model<MovieCreditDocument>('MovieCredit', movieCreditSchema);
