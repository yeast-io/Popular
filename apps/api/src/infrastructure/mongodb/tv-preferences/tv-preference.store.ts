import type { Model } from 'mongoose';
import type { TrackedMoviePreference } from '@movie-hub/contract';
import type { TvPreferenceDocument } from './tv-preference.schema.js';
import type { TvPreferenceStore } from '../../../modules/tv-preferences/tv-preference.types.js';

export class MongoTvPreferenceStore implements TvPreferenceStore {
  constructor(private readonly model: Model<TvPreferenceDocument>) {}

  async read(ownerId: string, ids: number[]) {
    const rows = await this.model.find({ ownerId, tmdbId: { $in: ids } }).lean().exec();
    return rows.map((row) => ({ tmdbId: row.tmdbId, preference: row.preference }));
  }

  async set(ownerId: string, tmdbId: number, preference: TrackedMoviePreference) {
    try {
      await this.model.updateOne({ ownerId, tmdbId }, { $set: { preference } }, { upsert: true, runValidators: true }).exec();
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 11000)) throw error;
      await this.model.updateOne({ ownerId, tmdbId }, { $set: { preference } }, { runValidators: true }).exec();
    }
  }

  async clear(ownerId: string, tmdbId: number) {
    await this.model.deleteOne({ ownerId, tmdbId }).exec();
  }
}
