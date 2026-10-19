import type { Model } from 'mongoose';
import type { MovieStatusRecord, MovieStatusStore } from '../../../modules/movies/movie.types.js';
import type { UserMovieStateDocument } from './user-movie-state.schema.js';

export class MongoMovieStatusStore implements MovieStatusStore {
  constructor(
    private readonly states: Model<UserMovieStateDocument>
  ) {}

  async setStatus(
    ownerId: string,
    tmdbId: number,
    status: Exclude<MovieStatusRecord['status'], 'unwatched'>,
  ): Promise<MovieStatusRecord['status'] | null> {
    const previous = await this.states.findOne({ ownerId, tmdbId }).lean().exec();
    await this.states
      .updateOne(
        { ownerId, tmdbId },
        {
          $set: { status, ...(previous?.status === 'not_interested' ? { preference: 'disliked' } : {}) },
          $setOnInsert: { preference: 'neutral' },
        },
        { upsert: true },
      )
      .exec();
    return previous ? normalizeStatus(previous.status) : null;
  }

  async clearStatus(ownerId: string, tmdbId: number): Promise<void> {
    const previous = await this.states.findOne({ ownerId, tmdbId }).lean().exec();
    if (!previous) return;
    const row = await this.states
      .findOneAndUpdate(
        { ownerId, tmdbId },
        { $set: { status: 'unwatched', ...(previous.status === 'not_interested' ? { preference: 'disliked' } : {}) } },
        { returnDocument: 'after' },
      )
      .lean()
      .exec();
    if (row && normalizePreference(row) === 'neutral') await this.states.deleteOne({ ownerId, tmdbId }).exec();
  }

  async setPreference(
    ownerId: string,
    tmdbId: number,
    preference: Exclude<MovieStatusRecord['preference'], 'neutral'>,
  ): Promise<MovieStatusRecord['preference']> {
    const previous = await this.states.findOne({ ownerId, tmdbId }).lean().exec();
    await this.states
      .updateOne(
        { ownerId, tmdbId },
        {
          $set: { preference, ...(previous?.status === 'not_interested' ? { status: 'unwatched' } : {}) },
          $setOnInsert: { status: 'unwatched' },
        },
        { upsert: true },
      )
      .exec();
    return previous ? normalizePreference(previous) : 'neutral';
  }

  async clearPreference(ownerId: string, tmdbId: number): Promise<void> {
    const previous = await this.states.findOne({ ownerId, tmdbId }).lean().exec();
    if (!previous) return;
    const row = await this.states
      .findOneAndUpdate(
        { ownerId, tmdbId },
        { $set: { preference: 'neutral', ...(previous.status === 'not_interested' ? { status: 'unwatched' } : {}) } },
        { returnDocument: 'after' },
      )
      .lean()
      .exec();
    if (row && normalizeStatus(row.status) === 'unwatched') await this.states.deleteOne({ ownerId, tmdbId }).exec();
  }

  async readForMovies(ownerId: string, tmdbIds: number[]): Promise<MovieStatusRecord[]> {
    if (tmdbIds.length === 0) return [];
    const rows = await this.states
      .find({ ownerId, tmdbId: { $in: tmdbIds } })
      .lean()
      .exec();
    return rows.map(toRecord);
  }

  async list(
    ownerId: string,
    filterValue:
      | Exclude<MovieStatusRecord['status'], 'unwatched'>
      | Exclude<MovieStatusRecord['preference'], 'neutral'>
      | undefined,
    page: number,
    pageSize: number,
  ) {
    const filter =
      filterValue === 'liked'
        ? { ownerId, preference: 'liked' }
        : filterValue === 'disliked'
          ? { ownerId, $or: [{ preference: 'disliked' }, { status: 'not_interested' }] }
          : { ownerId, ...(filterValue ? { status: filterValue } : {}) };
    const [rows, total] = await Promise.all([
      this.states
        .find(filter)
        .sort({ updatedAt: -1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .lean()
        .exec(),
      this.states.countDocuments(filter).exec(),
    ]);
    return {
      items: rows.map(toRecord),
      total,
    };
  }
}

function normalizeStatus(status: string): MovieStatusRecord['status'] {
  return status === 'not_interested' ? 'unwatched' : (status as MovieStatusRecord['status']);
}

function normalizePreference(row: { status: string; preference?: string | null }): MovieStatusRecord['preference'] {
  if (row.status === 'not_interested') return 'disliked';
  return row.preference === 'liked' || row.preference === 'disliked' ? row.preference : 'neutral';
}

function toRecord(row: {
  tmdbId: number;
  status: string;
  preference?: string | null;
  updatedAt: Date;
}): MovieStatusRecord {
  return {
    tmdbId: row.tmdbId,
    status: normalizeStatus(row.status),
    preference: normalizePreference(row),
    updatedAt: row.updatedAt,
  };
}
