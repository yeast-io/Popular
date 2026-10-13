import type { MovieDownloadStatus } from '@movie-hub/contract';

export interface MovieDownloadRecord {
  id: string;
  ownerId: string;
  tmdbId: number;
  sourceProvider: 'mteam';
  sourceReleaseId: string;
  provider: 'qbittorrent';
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
  createSubmitting(ownerId: string, tmdbId: number, releaseId: string): Promise<MovieDownloadRecord>;
  retry(id: string): Promise<MovieDownloadRecord>;
  listForMovie(ownerId: string, tmdbId: number): Promise<MovieDownloadRecord[]>;
  updateProgress(id: string, progress: MovieDownloadProgress): Promise<MovieDownloadRecord>;
  markFailed(id: string, errorCode: string, attemptedAt: Date): Promise<MovieDownloadRecord>;
  markMissing(id: string, attemptedAt: Date): Promise<MovieDownloadRecord>;
}
