import type { MovieDownloadRecord } from '../downloads/movie-download.types.js';

export interface NotificationTestStore {
  listCompleted(ownerId: string, skip: number, limit: number): Promise<MovieDownloadRecord[]>;
  findCompleted(ownerId: string, id: string): Promise<MovieDownloadRecord | null>;
}
