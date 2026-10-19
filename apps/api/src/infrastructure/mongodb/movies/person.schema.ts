import { Schema, type Connection, type InferSchemaType } from 'mongoose';
import { supportedLocales } from '@movie-hub/contract';

const personSchema = new Schema(
  {
    tmdbId: { type: Number, required: true, min: 1 },
    locale: { type: String, required: true, enum: supportedLocales },
    name: { type: String, required: true },
    originalName: { type: String },
    profilePath: { type: String },
    syncedAt: { type: Date, required: true },
  },
  { timestamps: true, collection: 'people' },
);

personSchema.index({ tmdbId: 1, locale: 1 }, { unique: true });

export type PersonDocument = InferSchemaType<typeof personSchema>;
export const createPersonModel = (connection: Connection) => {
  return connection.model<PersonDocument>('Person', personSchema);
};
