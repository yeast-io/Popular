import type { MovieDownloadProgress } from './movie-download.types.js';

export type TorrentSnapshot = Omit<MovieDownloadProgress, 'addedAt' | 'lastSyncedAt'>;

export interface DownloadClient {
  add(torrent: Uint8Array, tag: string): Promise<string | undefined>;
  list(hashes: string[]): Promise<TorrentSnapshot[]>;
  findByTag(tag: string): Promise<TorrentSnapshot | null>;
}
