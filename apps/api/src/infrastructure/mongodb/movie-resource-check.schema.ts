import { Schema, type Connection, type InferSchemaType, type Types } from 'mongoose';

const movieResourceCheckSchema = new Schema({
  ownerId: { type: Schema.Types.ObjectId, required: true, ref: 'User' },
  tmdbId: { type: Number, required: true, min: 1 },
  provider: { type: String, required: true, enum: ['mteam'] },
  availability: {
    type: String,
    required: true,
    enum: ['available', 'unavailable', 'unchecked', 'unmatchable'],
    default: 'unchecked',
  },
  matchedBy: { type: String, enum: ['imdb'] },
  checkedAt: { type: Date },
  expiresAt: { type: Date },
  lastAttemptAt: { type: Date },
  lastAttemptStatus: { type: String, enum: ['success', 'error'] },
  lastErrorCode: {
    type: String,
    enum: [
      'authentication', 'permission', 'network', 'timeout', 'rate_limited',
      'invalid_response', 'remote_error', 'internal_error',
    ],
  },
}, { timestamps: true, collection: 'movie_resource_checks', versionKey: false });

movieResourceCheckSchema.index({ ownerId: 1, tmdbId: 1, provider: 1 }, { unique: true });
movieResourceCheckSchema.index({ expiresAt: 1, lastAttemptStatus: 1, lastAttemptAt: 1 });

export type MovieResourceCheckDocument = InferSchemaType<typeof movieResourceCheckSchema> & { ownerId: Types.ObjectId };
export const createMovieResourceCheckModel = (connection: Connection) =>
  connection.model<MovieResourceCheckDocument>('MovieResourceCheck', movieResourceCheckSchema);
