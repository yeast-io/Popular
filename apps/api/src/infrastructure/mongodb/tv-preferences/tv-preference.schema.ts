import { Schema, type Connection, type InferSchemaType } from 'mongoose';

const schema = new Schema({
  ownerId: { type: Schema.Types.ObjectId, required: true, ref: 'User' },
  tmdbId: { type: Number, required: true, min: 1, validate: Number.isInteger },
  preference: { type: String, enum: ['liked', 'disliked'], required: true },
}, { timestamps: true, collection: 'user_tv_preferences' });
schema.index({ ownerId: 1, tmdbId: 1 }, { unique: true });
export type TvPreferenceDocument = InferSchemaType<typeof schema>;
export const createTvPreferenceModel = (connection: Connection) => connection.model<TvPreferenceDocument>('TvPreference', schema);
