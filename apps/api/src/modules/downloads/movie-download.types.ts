import type { DownloadProvider, DownloadSource, MovieDownloadStatus } from '@movie-hub/contract';

export interface MovieDownloadRecord {
  id: string;
  ownerId: string;
  tmdbId: number;
  sourceProvider: DownloadSource;
  sourceReleaseId: string;
  provider?: DownloadProvider | undefined;
  downloaderInstanceId?: string;
  downloaderName?: string;
  lookupTag: string;
  executionMode?: 'local' | 'remote';
  remoteDeviceId?: string;
  remoteCommandId?: string;
  remoteCorrelationId?: string;
  queueExpiresAt?: Date;
  pushState?: string;
  retryAttempt?: number;
  torrentHash?: string;
  name?: string;
  status: MovieDownloadStatus;
  progress: number;
  downloadedBytes?: number;
  totalBytes?: number;
  downloadSpeed?: number;
  etaSeconds?: number;
  lastErrorCode?: string;
  addedAt?: Date;
  lastSyncedAt?: Date;
}

export interface MovieDownloadProgress {
  torrentHash: string;
  name: string;
  status: MovieDownloadStatus;
  progress: number;
  downloadedBytes: number;
  totalBytes: number;
  downloadSpeed: number;
  etaSeconds: number;
  addedAt?: Date;
  lastSyncedAt: Date;
}

export interface MovieDownloadStore {
  findByRelease(
    ownerId: string,
    tmdbId: number,
    releaseId: string,
    sourceProvider?: DownloadSource,
  ): Promise<MovieDownloadRecord | null>;
  createSubmitting(
    ownerId: string,
    tmdbId: number,
    releaseId: string,
    provider: DownloadProvider | undefined,
    sourceProvider?: DownloadSource,
    downloaderInstanceId?: string,
    downloaderName?: string,
    remote?: RemoteDownloadTarget,
  ): Promise<DownloadClaim>;
  retry(id: string): Promise<DownloadClaim>;
  claimMissing(record: MovieDownloadRecord, provider: DownloadProvider | undefined,
    downloaderInstanceId?: string, downloaderName?: string, remote?: RemoteDownloadTarget): Promise<DownloadClaim>;
  listForMovie(ownerId: string, tmdbId: number): Promise<MovieDownloadRecord[]>;
  updateProgress(id: string, progress: MovieDownloadProgress): Promise<MovieDownloadRecord>;
  markFailed(id: string, errorCode: string, attemptedAt: Date): Promise<MovieDownloadRecord>;
  markMissing(id: string, attemptedAt: Date): Promise<MovieDownloadRecord>;
}

export interface DownloadClaim {
  record: MovieDownloadRecord;
  claimed: boolean;
}

export interface RemoteDownloadTarget {
  displayTitle?: string;
  deviceId: string; authVersion: number; deviceVersion: number; correlationId: string;
  targetDownloader?: { downloaderType: DownloadProvider; instanceId: string };
}
