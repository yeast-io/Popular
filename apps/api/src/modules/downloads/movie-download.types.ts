import type { DownloadProvider, MovieDownloadStatus } from '@movie-hub/contract';

export interface MovieDownloadRecord {
  id: string;
  ownerId: string;
  tmdbId: number;
  sourceProvider: 'mteam';
  sourceReleaseId: string;
  provider: DownloadProvider;
  lookupTag: string;
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
  findByRelease(ownerId: string, tmdbId: number, releaseId: string): Promise<MovieDownloadRecord | null>;
  createSubmitting(
    ownerId: string,
    tmdbId: number,
    releaseId: string,
    provider: DownloadProvider,
  ): Promise<DownloadClaim>;
  retry(id: string): Promise<DownloadClaim>;
  listForMovie(ownerId: string, tmdbId: number): Promise<MovieDownloadRecord[]>;
  updateProgress(id: string, progress: MovieDownloadProgress): Promise<MovieDownloadRecord>;
  markFailed(id: string, errorCode: string, attemptedAt: Date): Promise<MovieDownloadRecord>;
  markMissing(id: string, attemptedAt: Date): Promise<MovieDownloadRecord>;
}

export interface DownloadClaim {
  record: MovieDownloadRecord;
  claimed: boolean;
}
