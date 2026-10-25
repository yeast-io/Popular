import type { MovieDownload } from '@movie-hub/contract';
import type { MovieDownloadRecord } from './movie-download.types.js';

export function toResponse(record: MovieDownloadRecord): MovieDownload {
  const response = {
    id: record.id,
    ...(record.tmdbId !== undefined ? { tmdbId: record.tmdbId } : {}),
    sourceProvider: record.sourceProvider,
    sourceReleaseId: record.sourceReleaseId,
    ...(record.provider ? { provider: record.provider } : {}),
    ...(record.downloaderInstanceId ? { downloaderInstanceId: record.downloaderInstanceId } : {}),
    ...(record.downloaderName ? { downloaderName: record.downloaderName } : {}),
    ...(record.remoteDeviceId ? { remoteDeviceId: record.remoteDeviceId } : {}),
    ...(record.queueExpiresAt ? { queueExpiresAt: record.queueExpiresAt.toISOString() } : {}),
    ...(record.pushState ? { pushState: record.pushState } : {}),
    ...(record.retryAttempt !== undefined ? { retryAttempt: record.retryAttempt } : {}),
    status: record.status,
    progress: record.progress,
    ...(record.downloadedBytes !== undefined ? { downloadedBytes: record.downloadedBytes } : {}),
    ...(record.totalBytes !== undefined ? { totalBytes: record.totalBytes } : {}),
    ...(record.downloadSpeed !== undefined ? { downloadSpeed: record.downloadSpeed } : {}),
    ...(record.etaSeconds !== undefined ? { etaSeconds: record.etaSeconds } : {}),
    ...(record.lastErrorCode ? { lastErrorCode: record.lastErrorCode } : {}),
    ...(record.addedAt ? { addedAt: record.addedAt.toISOString() } : {}),
    ...(record.lastSyncedAt ? { lastSyncedAt: record.lastSyncedAt.toISOString() } : {}),
  };
  if (record.executionMode === 'remote') return { ...response, executionMode: 'remote' };
  if (!record.provider) throw new Error('Local download is missing its provider');
  return { ...response, provider: record.provider, ...(record.executionMode ? { executionMode: 'local' as const } : {}) };
}
