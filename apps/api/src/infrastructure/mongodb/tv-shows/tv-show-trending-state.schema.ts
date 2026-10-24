import { Schema, type Connection, type InferSchemaType } from 'mongoose';

const schema = new Schema({
  locale: { type: String, required: true, enum: ['en-US', 'zh-CN'] },
  timeWindow: { type: String, required: true, enum: ['week'] },
  activeGeneration: { type: String, required: true },
  publishedAt: { type: Date, required: true },
}, { timestamps: true, collection: 'tv_show_trending_states' });
schema.index({ locale: 1, timeWindow: 1 }, { unique: true });
export type TvShowTrendingStateDocument = InferSchemaType<typeof schema>;
export const createTvShowTrendingStateModel = (connection: Connection) => connection.model<TvShowTrendingStateDocument>('TvShowTrendingState', schema);
