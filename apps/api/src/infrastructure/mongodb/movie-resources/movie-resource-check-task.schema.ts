import { Schema, type Connection, type InferSchemaType, type Types } from 'mongoose';

const movieResourceCheckTaskSchema = new Schema(
  {
    ownerId: { type: Schema.Types.ObjectId, required: true, ref: 'User' },
    tmdbId: { type: Number, required: true, min: 1 },
    provider: { type: String, required: true, match: /^[a-z][a-z0-9-]{0,31}$/ },
    status: { type: String, required: true, enum: ['checking'] },
    attemptedAt: { type: Date, required: true },
    leaseExpiresAt: { type: Date, required: true },
  },
  { collection: 'movie_resource_check_tasks', versionKey: false },
);

movieResourceCheckTaskSchema.index({ ownerId: 1, tmdbId: 1, provider: 1 }, { unique: true });
movieResourceCheckTaskSchema.index({ leaseExpiresAt: 1 });

export type MovieResourceCheckTaskDocument = InferSchemaType<typeof movieResourceCheckTaskSchema> & {
  ownerId: Types.ObjectId;
};
export const createMovieResourceCheckTaskModel = (connection: Connection) => {
  return connection.model<MovieResourceCheckTaskDocument>('MovieResourceCheckTask', movieResourceCheckTaskSchema);
};
