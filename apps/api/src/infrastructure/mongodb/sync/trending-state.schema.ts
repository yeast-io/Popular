import type { Locale } from '@movie-hub/contract';
import { Schema, type Connection, type InferSchemaType } from 'mongoose';

const trendingStateSchema = new Schema(
  {
    locale: { type: String, required: true, enum: ['zh-CN', 'en-US'] },
    activeGeneration: { type: String, required: true },
    publishedAt: { type: Date, required: true },
  },
  { timestamps: true, collection: 'trending_states' }
);

trendingStateSchema.index({ locale: 1 }, { unique: true });

export type TrendingStateDocument = InferSchemaType<typeof trendingStateSchema> & { locale: Locale };
export const createTrendingStateModel = (connection: Connection) => {
  return connection.model<TrendingStateDocument>('TrendingState', trendingStateSchema);
};
