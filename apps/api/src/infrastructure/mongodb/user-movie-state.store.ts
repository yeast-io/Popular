import type { Model } from 'mongoose';
import type { MovieStatusRecord, MovieStatusStore } from '../../modules/movies/movie.types.js';
import type { UserMovieStateDocument } from './user-movie-state.schema.js';

export class MongoMovieStatusStore implements MovieStatusStore {
  constructor(private readonly states: Model<UserMovieStateDocument>) {}

  async set(ownerId: string, tmdbId: number, status: MovieStatusRecord['status']): Promise<void> {
    await this.states.updateOne({ ownerId, tmdbId }, { $set: { status } }, { upsert: true }).exec();
  }

  async delete(ownerId: string, tmdbId: number): Promise<void> {
    await this.states.deleteOne({ ownerId, tmdbId }).exec();
  }

  async readForMovies(ownerId: string, tmdbIds: number[]): Promise<MovieStatusRecord[]> {
    if (tmdbIds.length === 0) return [];
    const rows = await this.states.find({ ownerId, tmdbId: { $in: tmdbIds } }).lean().exec();
    return rows.map((row) => ({ tmdbId: row.tmdbId, status: row.status as MovieStatusRecord['status'], updatedAt: row.updatedAt }));
  }

  async list(ownerId: string, status: MovieStatusRecord['status'] | undefined, page: number, pageSize: number) {
    const filter = { ownerId, ...(status ? { status } : {}) };
    const [rows, total] = await Promise.all([
      this.states.find(filter).sort({ updatedAt: -1 }).skip((page - 1) * pageSize).limit(pageSize).lean().exec(),
      this.states.countDocuments(filter).exec(),
    ]);
    return {
      items: rows.map((row) => ({ tmdbId: row.tmdbId, status: row.status as MovieStatusRecord['status'], updatedAt: row.updatedAt })),
      total,
    };
  }
}
