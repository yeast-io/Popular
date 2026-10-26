import { Schema, type Connection, type InferSchemaType } from 'mongoose';

export const tvWatchlistSchema = new Schema({
  ownerId: { type: Schema.Types.ObjectId, required: true, ref: 'User' },
  tmdbId: { type: Number, required: true, min: 1 },
  resourceNotificationEnabled: { type: Boolean, default: false },
}, { timestamps: true, collection: 'user_tv_watchlist' });
tvWatchlistSchema.index({ ownerId: 1, tmdbId: 1 }, { unique: true });
tvWatchlistSchema.index({ ownerId: 1, createdAt: -1, _id: -1 });
export type TvWatchlistDocument = InferSchemaType<typeof tvWatchlistSchema>;
export const createTvWatchlistModel = (connection: Connection) => connection.model<TvWatchlistDocument>('TvWatchlist', tvWatchlistSchema);
