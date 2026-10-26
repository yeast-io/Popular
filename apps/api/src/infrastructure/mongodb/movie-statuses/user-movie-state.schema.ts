import { Schema, type Connection, type InferSchemaType, type Types } from 'mongoose';
import { moviePreferences, movieStatuses } from '@movie-hub/contract';

const userMovieStateSchema = new Schema(
  {
    ownerId: { type: Schema.Types.ObjectId, required: true, ref: 'User' },
    tmdbId: { type: Number, required: true, min: 1 },
    resourceNotificationEnabled: { type: Boolean, default: false },
    status: { type: String, required: true, enum: [...movieStatuses, 'not_interested'], default: 'unwatched' },
    preference: { type: String, required: true, enum: moviePreferences, default: 'neutral' },
  },
  { timestamps: true, collection: 'user_movie_states' }
);

userMovieStateSchema.index({ ownerId: 1, tmdbId: 1 }, { unique: true });
userMovieStateSchema.index({ ownerId: 1, status: 1, updatedAt: -1 });
userMovieStateSchema.index({ ownerId: 1, preference: 1, updatedAt: -1 });

export type UserMovieStateDocument = InferSchemaType<typeof userMovieStateSchema> & { ownerId: Types.ObjectId };
export const createUserMovieStateModel = (connection: Connection) => {
  return connection.model<UserMovieStateDocument>('UserMovieState', userMovieStateSchema);
};
