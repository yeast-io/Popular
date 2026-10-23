import { randomUUID } from 'node:crypto';
import { fingerprint } from '../../../modules/remote-downloads/remote-download.domain.js';
import { REMOTE_QUEUE_RETENTION_MS, REMOTE_DELIVERY_TTL_MS } from '../../../modules/remote-downloads/remote-download.policy.js';
import type { RemoteDownloadTarget } from '../../../modules/downloads/movie-download.types.js';
import { MISSING_DOWNLOAD_RETENTION_MS } from '../../../modules/downloads/movie-download.policy.js';
import { Types, type Model, type UpdateWithAggregationPipeline } from 'mongoose';
import type { DownloadProvider, DownloadSource, MovieDownloadStatus } from '@movie-hub/contract';
import type {
  DownloadClaim,
  MovieDownloadProgress,
  MovieDownloadRecord,
  MovieDownloadStore,
} from '../../../modules/downloads/movie-download.types.js';
import type { MovieDownloadDocument } from './movie-download.schema.js';

export class MongoMovieDownloadStore implements MovieDownloadStore {
  constructor(private readonly downloads: Model<MovieDownloadDocument>) {}

  async findByRelease(
    ownerId: string,
    tmdbId: number,
    releaseId: string,
    sourceProvider: DownloadSource = 'mteam'
  ): Promise<MovieDownloadRecord | null> {
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
    provider: DownloadProvider | undefined,
    sourceProvider: DownloadSource = 'mteam',
    downloaderInstanceId?: string,
    downloaderName?: string,
    remote?: RemoteDownloadTarget
  ): Promise<DownloadClaim> {
    const id = new Types.ObjectId();
    const now = Date.now();
    const input = remote
      ? { commandId: randomUUID(), downloadId: id.toHexString(), ownerId,
          deviceId: remote.deviceId, authVersion: remote.authVersion, deviceVersion: remote.deviceVersion,
          source: sourceProvider, resourceId: releaseId, correlationId: remote.correlationId }
      : undefined;
    const remoteRequest = input
      ? { ...input, digest: fingerprint(input), createdAt: now, ...(remote?.displayTitle ? { displayTitle: remote.displayTitle } : {}),
          expiresAt: now + REMOTE_DELIVERY_TTL_MS, queueExpiresAt: now + REMOTE_QUEUE_RETENTION_MS,
          deliverySessionId: 'queued', deliveryMessageId: randomUUID(), ...(remote?.targetDownloader ? { targetDownloader: remote.targetDownloader } : {}) }
      : undefined;
    try {
      const row = await this.downloads.create({
        _id: id,
        ownerId,
        tmdbId,
        sourceProvider,
        sourceReleaseId: releaseId,
        provider,
        ...(downloaderInstanceId ? { downloaderInstanceId } : {}),
        ...(downloaderName ? { downloaderName } : {}),
        lookupTag: `movie-hub-${id.toHexString()}`,
        status: 'submitting',
        progress: 0,
        ...(remoteRequest
          ? { executionMode: 'remote', remoteRequest, remoteRequestState: 'accepted',
              remoteQueueExpiresAt: new Date(remoteRequest.queueExpiresAt) }
          : {}),
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
        { new: true }
      )
      .lean()
      .exec();
    if (row) return { record: toMovieDownloadRecord(row), claimed: true };
    const existing = await this.downloads.findById(id).lean().exec();
    if (!existing) throw new Error('Movie download disappeared during retry');
    return { record: toMovieDownloadRecord(existing), claimed: false };
  }

  async claimMissing(record: MovieDownloadRecord, provider: DownloadProvider | undefined,
    downloaderInstanceId?: string, downloaderName?: string, remote?: RemoteDownloadTarget): Promise<DownloadClaim> {
    const now = Date.now();
    const input = remote
      ? { commandId: randomUUID(), downloadId: record.id, ownerId: record.ownerId,
          deviceId: remote.deviceId, authVersion: remote.authVersion, deviceVersion: remote.deviceVersion,
          source: record.sourceProvider, resourceId: record.sourceReleaseId, correlationId: remote.correlationId }
      : undefined;
    const remoteRequest = input
      ? { ...input, digest: fingerprint(input), createdAt: now, ...(remote?.displayTitle ? { displayTitle: remote.displayTitle } : {}),
          expiresAt: now + REMOTE_DELIVERY_TTL_MS, queueExpiresAt: now + REMOTE_QUEUE_RETENTION_MS,
          deliverySessionId: 'queued', deliveryMessageId: randomUUID(),
          ...(remote?.targetDownloader ? { targetDownloader: remote.targetDownloader } : {}) }
      : undefined;
    const filter = {
      _id: record.id, ownerId: record.ownerId, status: 'missing',
      ...(record.executionMode === 'remote'
        ? { 'executionMode': 'remote', 'remoteRequest.commandId': record.remoteCommandId,
            'remoteRequestState': 'succeeded', 'remoteStatusState': 'deleted' }
        : { executionMode: { $ne: 'remote' }, lookupTag: record.lookupTag }),
    };
    const unset: Record<string, number> = { remoteAssociation: 1, remoteOutcome: 1, remoteRetryAttempt: 1,
      remoteProjectionRevision: 1, remoteStatusSequence: 1, remoteStatusState: 1, missingSince: 1, expiresAt: 1,
      downloadedBytes: 1, totalBytes: 1, downloadSpeed: 1, etaSeconds: 1, torrentHash: 1, name: 1,
      lastErrorCode: 1, addedAt: 1, lastSyncedAt: 1, notificationIntent: 1, notificationTask: 1 };
    if (!remoteRequest) Object.assign(unset, { remoteRequest: 1, remoteRequestState: 1,
      remoteCommandRegistered: 1, remoteQueueExpiresAt: 1 });
    if (!provider) unset.provider = 1;
    if (!downloaderInstanceId) unset.downloaderInstanceId = 1;
    if (!downloaderName) unset.downloaderName = 1;
    const row = await this.downloads.findOneAndUpdate(filter, {
      $set: { status: 'submitting', progress: 0, lookupTag: `movie-hub-${randomUUID()}`,
        executionMode: remote ? 'remote' : 'local', ...(provider ? { provider } : {}),
        ...(downloaderInstanceId ? { downloaderInstanceId } : {}), ...(downloaderName ? { downloaderName } : {}),
        ...(remoteRequest
          ? { remoteRequest, remoteRequestState: 'accepted', remoteCommandRegistered: false,
              remoteQueueExpiresAt: new Date(remoteRequest.queueExpiresAt) }
          : {}) },
      $unset: unset,
    }, { new: true }).lean().exec();
    if (row) return { record: toMovieDownloadRecord(row), claimed: true };
    const current = await this.findByRelease(record.ownerId, record.tmdbId, record.sourceReleaseId, record.sourceProvider);
    if (!current) throw new Error('Movie download disappeared during redownload');
    return { record: current, claimed: false };
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
    return this.update(id, [
      {
        $set: {
          status: 'missing',
          lastErrorCode: 'DOWNLOAD_TORRENT_MISSING',
          lastSyncedAt: attemptedAt,
          missingSince: { $ifNull: ['$missingSince', attemptedAt] },
          expiresAt: { $add: [{ $ifNull: ['$missingSince', attemptedAt] }, MISSING_DOWNLOAD_RETENTION_MS] },
          downloadSpeed: 0,
          etaSeconds: '$$REMOVE',
        },
      },
    ]);
  }

  private async update(
    id: string,
    update: Record<string, unknown> | UpdateWithAggregationPipeline
  ): Promise<MovieDownloadRecord> {
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
    ...(row.provider ? { provider: row.provider as DownloadProvider } : {}),
    ...(row.downloaderInstanceId ? { downloaderInstanceId: row.downloaderInstanceId } : {}),
    ...(row.downloaderName ? { downloaderName: row.downloaderName } : {}),
    lookupTag: row.lookupTag,
    ...(row.executionMode ? { executionMode: row.executionMode as 'local' | 'remote' } : {}),
    ...(row.remoteRequest?.deviceId ? { remoteDeviceId: row.remoteRequest.deviceId } : {}),
    ...(row.remoteRequest?.commandId ? { remoteCommandId: row.remoteRequest.commandId } : {}),
    ...(row.remoteRequest?.correlationId ? { remoteCorrelationId: row.remoteRequest.correlationId } : {}),
    ...(row.remoteQueueExpiresAt ? { queueExpiresAt: row.remoteQueueExpiresAt } : {}),
    ...(row.remoteRequestState ? { pushState: row.remoteRequestState } : {}),
    ...(row.remoteRetryAttempt !== undefined && row.remoteRetryAttempt !== null ? { retryAttempt: row.remoteRetryAttempt } : {}),
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
