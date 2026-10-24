import { Schema, type Connection, type InferSchemaType } from 'mongoose';

const schema = new Schema({
  key: { type: String, required: true },
  type: { type: String, required: true, enum: ['trending'] },
  locale: { type: String, required: true, enum: ['en-US', 'zh-CN'] },
  timeWindow: { type: String, required: true, enum: ['week'] },
  generation: { type: String, required: true },
  page: { type: Number, min: 1, validate: Number.isInteger, required: true },
  tmdbIds: { type: [Number], required: true, default: undefined },
  totalPages: { type: Number, min: 0, validate: Number.isInteger, required: true },
  totalResults: { type: Number, min: 0, validate: Number.isInteger, required: true },
  fetchedAt: { type: Date, required: true },
  freshUntil: { type: Date, required: true },
  deleteAt: { type: Date },
}, { timestamps: true, collection: 'tv_show_result_sets' });
schema.index({ key: 1 }, { unique: true });
schema.index({ type: 1, locale: 1, timeWindow: 1, generation: 1, page: 1 }, { unique: true });
schema.index({ deleteAt: 1 }, { expireAfterSeconds: 0 });
export type TvShowResultSetDocument = InferSchemaType<typeof schema>;
export const createTvShowResultSetModel = (connection: Connection) => connection.model<TvShowResultSetDocument>('TvShowResultSet', schema);
