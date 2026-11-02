import type { MovieDownloadProgress } from './movie-download.types.js';
import type { DownloadProvider, DownloaderChoice, Locale } from '@movie-hub/contract';

export type TorrentSnapshot = Omit<MovieDownloadProgress, 'addedAt' | 'lastSyncedAt'>;

export interface DownloadClient {
  add(torrentUrl: string, tag: string): Promise<string | undefined>;
  list(hashes: string[]): Promise<TorrentSnapshot[]>;
  findByTag(tag: string): Promise<TorrentSnapshot | null>;
}

export interface DownloadClientFactory {
  instancesFor(ownerId: string): Promise<DownloaderChoice[]>;
  clientFor(ownerId: string, provider: DownloadProvider, downloaderInstanceId?: string, locale?: Locale): Promise<DownloadClient>;
}
