import { Schema, type Connection, type InferSchemaType } from 'mongoose';

const movieResultSetSchema = new Schema(
  {
    key: { type: String, required: true },
    type: { type: String, required: true, enum: ['search'] },
    params: { type: Schema.Types.Mixed, required: true },
    page: { type: Number, required: true, min: 1 },
    tmdbIds: { type: [Number], required: true },
    totalPages: { type: Number, required: true, min: 0 },
    totalResults: { type: Number, required: true, min: 0 },
    fetchedAt: { type: Date, required: true },
    deleteAt: { type: Date },
  },
  { timestamps: true, collection: 'movie_result_sets' }
);

movieResultSetSchema.index({ key: 1 }, { unique: true });
movieResultSetSchema.index({ deleteAt: 1 }, { expireAfterSeconds: 0 });

export type MovieResultSetDocument = InferSchemaType<typeof movieResultSetSchema>;
export const createMovieResultSetModel = (connection: Connection) => {
  return connection.model<MovieResultSetDocument>('MovieResultSet', movieResultSetSchema);
};
