import { MISSING_DOWNLOAD_RETENTION_MS } from '../../../modules/downloads/movie-download.policy.js';
import { Types, type Model, type UpdateWithAggregationPipeline } from 'mongoose';
import type { DownloadProvider, DownloadSource, MovieDownloadStatus } from '@movie-hub/contract';
import type { DownloadClaim, MovieDownloadProgress, MovieDownloadRecord, MovieDownloadStore } from '../../../modules/downloads/movie-download.types.js';
import type { MovieDownloadDocument } from './movie-download.schema.js';

export class MongoMovieDownloadStore implements MovieDownloadStore {
  constructor(
    private readonly downloads: Model<MovieDownloadDocument>
  ) {}

  async findByRelease(ownerId: string, tmdbId: number, releaseId: string, sourceProvider: DownloadSource = 'mteam'): Promise<MovieDownloadRecord | null> {
    const row = await this.downloads
      .findOne({ ownerId, tmdbId, sourceProvider, sourceReleaseId: releaseId })
      .lean()
      .exec();
    return row ? toMovieDownloadRecord(row) : null;
  }

  async createSubmitting(
    ownerId: string,
    tmdbId: number,
    releaseId: string,
    provider: DownloadProvider,
    sourceProvider: DownloadSource = 'mteam',
  ): Promise<DownloadClaim> {
    const id = new Types.ObjectId();
    try {
      const row = await this.downloads.create({
        _id: id,
        ownerId,
        tmdbId,
        sourceProvider,
        sourceReleaseId: releaseId,
        provider,
        lookupTag: `movie-hub-${id.toHexString()}`,
        status: 'submitting',
        progress: 0,
      });
      return { record: toMovieDownloadRecord(row.toObject()), claimed: true };
    } catch (error) {
      if (isDuplicateKey(error)) {
        const existing = await this.findByRelease(ownerId, tmdbId, releaseId, sourceProvider);
        if (existing) return { record: existing, claimed: false };
      }
      throw error;
    }
  }

  async retry(id: string): Promise<DownloadClaim> {
    const row = await this.downloads
      .findOneAndUpdate(
        { _id: id, status: { $in: ['failed', 'missing'] } },
        {
          $set: { status: 'submitting', progress: 0 },
          $unset: {
            missingSince: 1,
            expiresAt: 1,
            downloadedBytes: 1,
            totalBytes: 1,
            downloadSpeed: 1,
            etaSeconds: 1,
            torrentHash: 1,
            name: 1,
            lastErrorCode: 1,
            addedAt: 1,
            lastSyncedAt: 1,
            notificationIntent: 1,
            notificationTask: 1,
          },
        },
        { new: true },
      )
      .lean()
      .exec();
    if (row) return { record: toMovieDownloadRecord(row), claimed: true };
    const existing = await this.downloads.findById(id).lean().exec();
    if (!existing) throw new Error('Movie download disappeared during retry');
    return { record: toMovieDownloadRecord(existing), claimed: false };
  }

  async listForMovie(ownerId: string, tmdbId: number): Promise<MovieDownloadRecord[]> {
    const rows = await this.downloads.find({ ownerId, tmdbId }).sort({ createdAt: 1 }).lean().exec();
    return rows.map(toMovieDownloadRecord);
  }

  async updateProgress(id: string, progress: MovieDownloadProgress): Promise<MovieDownloadRecord> {
    return this.update(id, {
      $set: progress,
      $unset: { lastErrorCode: 1, missingSince: 1, expiresAt: 1 },
    });
  }

  async markFailed(id: string, errorCode: string, attemptedAt: Date): Promise<MovieDownloadRecord> {
    return this.update(id, {
      $set: { status: 'failed', lastErrorCode: errorCode, lastSyncedAt: attemptedAt },
      $unset: { missingSince: 1, expiresAt: 1 },
    });
  }

  async markMissing(id: string, attemptedAt: Date): Promise<MovieDownloadRecord> {
    // Atomic initialization: repeated polls must retain the first missing timestamp.
    return this.update(id, [{
      $set: {
        status: 'missing', lastErrorCode: 'DOWNLOAD_TORRENT_MISSING', lastSyncedAt: attemptedAt,
        missingSince: { $ifNull: ['$missingSince', attemptedAt] },
        expiresAt: { $add: [{ $ifNull: ['$missingSince', attemptedAt] }, MISSING_DOWNLOAD_RETENTION_MS] },
        downloadSpeed: 0,
        etaSeconds: '$$REMOVE',
      },
    }]);
  }

  private async update(id: string, update: Record<string, unknown> | UpdateWithAggregationPipeline): Promise<MovieDownloadRecord> {
    const row = await this.downloads.findByIdAndUpdate(id, update, { new: true }).lean().exec();
    if (!row) throw new Error('Movie download disappeared during update');
    return toMovieDownloadRecord(row);
  }
}

export function toMovieDownloadRecord(row: MovieDownloadDocument & { _id: unknown }): MovieDownloadRecord {
  return {
    id: String(row._id),
    ownerId: row.ownerId.toString(),
    tmdbId: row.tmdbId,
    sourceProvider: row.sourceProvider as DownloadSource,
    sourceReleaseId: row.sourceReleaseId,
    provider: row.provider as DownloadProvider,
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
