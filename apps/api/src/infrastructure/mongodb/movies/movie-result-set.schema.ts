import { Schema, type Connection, type InferSchemaType } from 'mongoose';

const movieResultSetSchema = new Schema({
  key: { type: String, required: true },
  type: { type: String, required: true, enum: ['trending', 'search'] },
  params: { type: Schema.Types.Mixed, required: true },
  page: { type: Number, required: true, min: 1 },
  tmdbIds: { type: [Number], required: true },
  totalPages: { type: Number, required: true, min: 0 },
  totalResults: { type: Number, required: true, min: 0 },
  fetchedAt: { type: Date, required: true },
  generation: { type: String },
  freshUntil: { type: Date },
  deleteAt: { type: Date },
}, { timestamps: true, collection: 'movie_result_sets' });

movieResultSetSchema.index({ key: 1 }, { unique: true });
movieResultSetSchema.index({ type: 1, generation: 1, page: 1 });
movieResultSetSchema.index({ deleteAt: 1 }, { expireAfterSeconds: 0 });

export type MovieResultSetDocument = InferSchemaType<typeof movieResultSetSchema>;
export const createMovieResultSetModel = (connection: Connection) => connection.model<MovieResultSetDocument>('MovieResultSet', movieResultSetSchema);
