import { Types, type Model } from 'mongoose';
import type { MovieDownloadStatus } from '@movie-hub/contract';
import type {
  MovieDownloadProgress,
  MovieDownloadRecord,
  MovieDownloadStore,
} from '../../modules/downloads/movie-download.types.js';
import type { MovieDownloadDocument } from './movie-download.schema.js';

export class MongoMovieDownloadStore implements MovieDownloadStore {
  constructor(private readonly downloads: Model<MovieDownloadDocument>) {}

  async findByRelease(ownerId: string, tmdbId: number, releaseId: string): Promise<MovieDownloadRecord | null> {
    const row = await this.downloads.findOne({ ownerId, tmdbId, sourceProvider: 'mteam', sourceReleaseId: releaseId }).lean().exec();
    return row ? toRecord(row) : null;
  }

  async createSubmitting(ownerId: string, tmdbId: number, releaseId: string): Promise<MovieDownloadRecord> {
    const id = new Types.ObjectId();
    try {
      const row = await this.downloads.create({
        _id: id,
        ownerId,
        tmdbId,
        sourceProvider: 'mteam',
        sourceReleaseId: releaseId,
        provider: 'qbittorrent',
        lookupTag: `movie-hub-${id.toHexString()}`,
        status: 'submitting',
        progress: 0,
      });
      return toRecord(row.toObject());
    } catch (error) {
      if (isDuplicateKey(error)) {
        const existing = await this.findByRelease(ownerId, tmdbId, releaseId);
        if (existing) return existing;
      }
      throw error;
    }
  }

  async retry(id: string): Promise<MovieDownloadRecord> {
    return this.update(id, {
      $set: { status: 'submitting', progress: 0 },
      $unset: { torrentHash: 1, name: 1, lastErrorCode: 1, addedAt: 1, lastSyncedAt: 1 },
    });
  }

  async listForMovie(ownerId: string, tmdbId: number): Promise<MovieDownloadRecord[]> {
    const rows = await this.downloads.find({ ownerId, tmdbId }).sort({ createdAt: 1 }).lean().exec();
    return rows.map(toRecord);
  }

  async updateProgress(id: string, progress: MovieDownloadProgress): Promise<MovieDownloadRecord> {
    return this.update(id, {
      $set: progress,
      $unset: { lastErrorCode: 1 },
    });
  }

  async markFailed(id: string, errorCode: string, attemptedAt: Date): Promise<MovieDownloadRecord> {
    return this.update(id, {
      $set: { status: 'failed', lastErrorCode: errorCode, lastSyncedAt: attemptedAt },
    });
  }

  async markMissing(id: string, attemptedAt: Date): Promise<MovieDownloadRecord> {
    return this.update(id, {
      $set: { status: 'missing', lastErrorCode: 'QBITTORRENT_TORRENT_MISSING', lastSyncedAt: attemptedAt },
    });
  }

  private async update(id: string, update: Record<string, unknown>): Promise<MovieDownloadRecord> {
    const row = await this.downloads.findByIdAndUpdate(id, update, { new: true }).lean().exec();
    if (!row) throw new Error('Movie download disappeared during update');
    return toRecord(row);
  }
}

function toRecord(row: MovieDownloadDocument & { _id: unknown }): MovieDownloadRecord {
  return {
    id: String(row._id),
    ownerId: row.ownerId.toString(),
    tmdbId: row.tmdbId,
    sourceProvider: 'mteam',
    sourceReleaseId: row.sourceReleaseId,
    provider: 'qbittorrent',
    lookupTag: row.lookupTag,
    status: row.status as MovieDownloadStatus,
    progress: row.progress,
    ...(row.torrentHash ? { torrentHash: row.torrentHash } : {}),
    ...(row.name ? { name: row.name } : {}),
    ...(typeof row.downloadedBytes === 'number' ? { downloadedBytes: row.downloadedBytes } : {}),
    ...(typeof row.totalBytes === 'number' ? { totalBytes: row.totalBytes } : {}),
    ...(typeof row.downloadSpeed === 'number' ? { downloadSpeed: row.downloadSpeed } : {}),
    ...(typeof row.etaSeconds === 'number' ? { etaSeconds: row.etaSeconds } : {}),
    ...(row.lastErrorCode ? { lastErrorCode: row.lastErrorCode } : {}),
    ...(row.addedAt ? { addedAt: row.addedAt } : {}),
    ...(row.lastSyncedAt ? { lastSyncedAt: row.lastSyncedAt } : {}),
  };
}

function isDuplicateKey(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 11000;
}
